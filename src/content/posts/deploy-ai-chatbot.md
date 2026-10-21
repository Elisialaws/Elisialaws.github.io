---
title: 从零部署一个 AI 聊天机器人
published: 2026-10-20
description: 一份能直接照抄的上线路径：vLLM 起 OpenAI 兼容服务、FastAPI 做 SSE 流式转发、Nginx 关掉缓冲、上下文预算怎么算、并发怎么限、成本怎么测。附完整可运行代码与上线检查清单。
image: ''
tags: [AI Infra, 部署, FastAPI, Nginx, vLLM]
category: 技术
draft: false
---

「部署一个 AI 聊天机器人」听起来像调个 API 就完事，真正上手会发现有一半时间花在流式输出断开、Nginx 缓冲导致「转圈十秒后一次性吐完」、上下文越聊越长最后显存爆掉这类问题上。

这篇按实际部署顺序走：起模型服务 → 写应用层 → 过网关 → 接前端 → 算成本和容量 → 上线检查。每一步都给可运行的配置，不讲概念。

## 一、先画清楚链路

```
浏览器 ──HTTPS──> Nginx ──HTTP──> FastAPI ──HTTP/SSE──> vLLM ──> GPU
                     │                │
                     │                └── 鉴权 / 限流 / 上下文裁剪 / 日志
                     └── TLS / 压缩关闭 / 超时 / 静态资源
```

关键判断：**推理服务和业务服务必须分开**。推理服务（vLLM）重、启动慢、吃显存、升级代价高；业务服务（FastAPI）轻、改得频繁。混在一个容器里，改一行提示词就要重启模型，每次三四分钟的不可用。

## 二、选模型和量化方式

先定三件事：硬件、语言、能接受的延迟。

| 硬件 | 推荐模型 | 量化 | 显存占用 | 单序列速度 |
| --- | --- | --- | --- | --- |
| 单卡 24G（4090/L4） | Qwen2.5-7B-Instruct | AWQ INT4 | ~5 GB | 50–70 tok/s |
| 单卡 48G（L40S/A6000） | Qwen2.5-14B-Instruct | AWQ INT4 | ~9 GB | 35–50 tok/s |
| 单卡 80G（A100/H100） | Qwen2.5-32B-Instruct | AWQ INT4 | ~19 GB | 25–35 tok/s |
| 纯 CPU / Mac | Qwen2.5-7B-Instruct | GGUF Q4_K_M | 内存 5–6 GB | 5–15 tok/s |

中文场景优先 Qwen 系列，指令跟随和中文表达明显比同尺寸的 Llama 系稳。**不要一上来就上 70B**——7B 量化版能覆盖 80% 的客服/问答场景，剩下的靠 RAG 补知识，比硬堆参数划算得多。

量化格式要和引擎对齐：vLLM 认 AWQ / GPTQ / FP8，llama.cpp 认 GGUF。用错会报一堆 shape mismatch。

## 三、起推理服务

用 compose 管起来，注意 `ipc: host` 和 `--max-model-len`：

```yaml
services:
  llm:
    image: vllm/vllm-openai:latest
    restart: unless-stopped
    ipc: host
    ports:
      - "127.0.0.1:8000:8000"
    volumes:
      - /data/models:/models:ro
    environment:
      - HF_HUB_OFFLINE=1
    command: >
      --model /models/Qwen2.5-7B-Instruct-AWQ
      --quantization awq
      --max-model-len 8192
      --gpu-memory-utilization 0.90
      --max-num-seqs 32
      --enable-prefix-caching
      --served-model-name chat
      --api-key ${LLM_API_KEY}
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 5s
      start_period: 300s
      retries: 3
```

几个参数的实际含义：

- `--max-model-len 8192`：单条请求最多 8K token（prompt + 输出）。这是**显存预算的上限**，设成 32768 会让每条会话的 KV 占用翻四倍，并发直接塌。模型支持 32K 不代表你要开 32K。
- `--max-num-seqs 32`：同时处理 32 条序列。超过的排队。这个数是延迟和吞吐的旋钮，调大吞吐涨但 TPOT 变差。
- `--enable-prefix-caching`：多轮对话的第二轮开始能省掉大量 prefill，TTFT 从几百毫秒掉到几十毫秒。
- `--api-key`：vLLM 自带的简单鉴权。即使只监听 127.0.0.1，也建议开——防止容器网络里其他服务乱调。
- `start_period: 300s`：模型加载要几分钟，健康检查别急着判死。

验证服务通了：

```bash
curl -s http://127.0.0.1:8000/v1/chat/completions \
  -H "Authorization: Bearer $LLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"chat","messages":[{"role":"user","content":"用一句话解释什么是 KV cache"}],"max_tokens":100}'
```

## 四、应用层：把流式转发做对

业务层的核心职责只有四件事：**拼消息、裁上下文、转流、记日志**。下面是完整可运行的 FastAPI 服务。

```python
# app/main.py
import json
import os
import time

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse

LLM_BASE = "http://127.0.0.1:8000/v1"
LLM_KEY = os.environ["LLM_API_KEY"]
MODEL = "chat"

# 上下文预算（token）。prompt + 输出总和不超模型上限，留 20% 余量
MAX_CONTEXT = 6400
MAX_OUTPUT = 1024

app = FastAPI()


def estimate_tokens(text: str) -> int:
    """粗略估算：中文约 1 字 = 1 token，英文约 4 字符 = 1 token。
    生产环境建议换成模型的 tokenizer，误差能压到 2% 以内。"""
    zh = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    other = len(text) - zh
    return zh + other // 4


def trim_history(messages: list[dict], budget: int) -> list[dict]:
    """保留 system + 最近的若干轮，超出预算从最老的消息开始丢。
    注意：必须成对丢弃，不能留下孤立的 assistant 消息。"""
    system = [m for m in messages if m["role"] == "system"]
    dialog = [m for m in messages if m["role"] != "system"]

    used = sum(estimate_tokens(m["content"]) for m in system)
    kept = []
    for msg in reversed(dialog):
        cost = estimate_tokens(msg["content"])
        if used + cost > budget:
            break
        used += cost
        kept.append(msg)
    kept.reverse()
    # 丢弃后首条必须是 user，避免出现连续 assistant
    while kept and kept[0]["role"] != "user":
        kept.pop(0)
    return system + kept


@app.post("/api/chat")
async def chat(req: Request):
    body = await req.json()
    messages = body.get("messages", [])
    if not messages:
        raise HTTPException(400, "messages 不能为空")

    messages = trim_history(messages, MAX_CONTEXT - MAX_OUTPUT)

    payload = {
        "model": MODEL,
        "messages": messages,
        "max_tokens": MAX_OUTPUT,
        "temperature": body.get("temperature", 0.7),
        "stream": True,
    }

    async def event_stream():
        started = time.time()
        first_token_at = None
        out_chars = 0
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=5.0)) as client:
                async with client.stream(
                    "POST",
                    f"{LLM_BASE}/chat/completions",
                    headers={"Authorization": f"Bearer {LLM_KEY}"},
                    json=payload,
                ) as upstream:
                    if upstream.status_code != 200:
                        detail = (await upstream.aread()).decode()[:300]
                        yield f"data: {json.dumps({'error': detail}, ensure_ascii=False)}\n\n"
                        return

                    async for line in upstream.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        data = line[6:]
                        if data == "[DONE]":
                            break
                        chunk = json.loads(data)
                        delta = chunk["choices"][0].get("delta", {})
                        text = delta.get("content")
                        if not text:
                            continue
                        if first_token_at is None:
                            first_token_at = time.time()
                        out_chars += len(text)
                        yield f"data: {json.dumps({'text': text}, ensure_ascii=False)}\n\n"

            yield "data: [DONE]\n\n"
        except Exception as exc:  # 上游超时 / 连接中断
            yield f"data: {json.dumps({'error': str(exc)}, ensure_ascii=False)}\n\n"
        finally:
            # 结构化日志：TTFT、总耗时、输出长度，都是容量规划要用的
            ttft = (first_token_at - started) if first_token_at else -1
            total = time.time() - started
            print(json.dumps({
                "event": "chat_done",
                "ttft_ms": round(ttft * 1000),
                "total_ms": round(total * 1000),
                "out_chars": out_chars,
                "ctx_tokens": sum(estimate_tokens(m["content"]) for m in messages),
            }))

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # 告诉 Nginx 别缓冲，这条最容易漏
            "Connection": "keep-alive",
        },
    )
```

这段代码里有四个坑，每一个都真实存在：

**坑一：`X-Accel-Buffering: no`。** 不加这个响应头，Nginx 默认开 `proxy_buffering`，它会攒够一个缓冲块才发出去。结果是用户盯着转圈十秒，然后一大段文字「啪」地出现——流式效果完全消失。

**坑二：客户端断开后要能感知。** `StreamingResponse` 在客户端断开时会抛 `asyncio.CancelledError`。默认行为下，上游那个 httpx 请求会继续跑完，白白消耗 GPU。生产环境应该监听 `request.is_disconnected()`，或者至少给上游加超时兜底。

**坑三：`estimate_tokens` 只是估算。** 中文按字算、英文按 4 字符算，误差在 10%–20%。要精确就加载模型自带的 tokenizer（`transformers` 的 `AutoTokenizer`），但注意别在业务进程里加载大模型权重，只加载 tokenizer 就行。

**坑四：裁剪历史不能留孤立的 assistant 消息。** 从尾部往前保留，很容易留下一条没有对应 user 的 assistant，部分模型会因此输出胡话或者直接报错。代码里那个 `while kept[0] != "user"` 就是干这个的。

## 五、网关：Nginx 的三行关键配置

代理 SSE 和代理普通接口是两回事，配置必须单独一个 location：

```nginx
location /api/chat {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;

    # 流式输出三件套
    proxy_buffering off;
    proxy_cache off;
    gzip off;

    # 长连接：一次生成可能几十秒，别用默认 60s
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

关于 `proxy_set_header Connection ""`：只在用 `proxy_http_version 1.1` 且上游支持 keep-alive 时才需要，写错（比如写成 `Connection: close`）反而可能让 SSE 断流。上面这份配置能直接工作，不必额外加。

gzip 也要关：对 SSE 开压缩，压缩器会攒够数据才输出，同样破坏流式。

## 六、前端：正确地读流

`EventSource` 只支持 GET，聊天要 POST，所以用 `fetch` + `ReadableStream`：

```javascript
async function send(messages, onDelta) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 以空行分帧，可能有半帧残留，必须留到下一轮
    const frames = buffer.split("\n\n");
    buffer = frames.pop();

    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      const parsed = JSON.parse(data);
      if (parsed.text) onDelta(parsed.text);
    }
  }
}
```

`decoder.decode(value, { stream: true })` 里的 `stream: true` 不能省。UTF-8 的中文是三个字节，很可能被切在两个 chunk 之间，不加这个参数就会出现「半个汉字」变成乱码。同理，`buffer.split("\n\n")` 之后必须把最后一个不完整帧 `pop()` 出来留到下一轮，直接丢掉会漏字。

## 七、鉴权与限流

对外暴露的聊天接口，至少要三层防护：

```python
from fastapi import Depends, Header, HTTPException
from collections import defaultdict
import time

# 1. 身份：简单 token，生产建议换成 JWT 或网关鉴权
async def verify(authorization: str = Header("")):
    if authorization != f"Bearer {os.environ['APP_TOKEN']}":
        raise HTTPException(401, "unauthorized")

# 2. 限流：滑动窗口，按 token 或 IP
_hits: dict[str, list[float]] = defaultdict(list)

def rate_limit(key: str, limit: int = 20, window: int = 60):
    now = time.time()
    hits = [t for t in _hits[key] if now - t < window]
    if len(hits) >= limit:
        raise HTTPException(429, "too many requests")
    hits.append(now)
    _hits[key] = hits
```

3. **单次输出上限**。`max_tokens` 必须在服务端硬编码一个上限，绝对不能信前端传的值。一个 `max_tokens: 100000` 的请求能把 KV cache 吃光，让所有人一起宕机。

另外，如果允许上传文件或让模型访问外部 URL，记得防 SSRF——内网地址（`127.0.0.1`、`169.254.169.254` 这类）一律拒绝。

## 八、成本与容量

先把成本算成单位价格。以 7B AWQ 跑在 4090（按租用价约 ¥2/小时）为例：

```
单卡吞吐（batch 满）：约 800 token/s
每小时输出：800 × 3600 ≈ 288 万 token
单位成本：2 / 2880000 × 1000 ≈ ¥0.0007 / 千 token
```

对比商业 API 的报价，自托管的成本优势要在**持续高负载**下才成立。日均几千次请求的场景，租卡反而更贵——卡是按小时计费的，闲着的也照收。这个账要在动手前算，而不是上线后才发现。

容量规划用上一节的公式：并发上限由 KV cache 决定。7B、4K 上下文、24G 卡，大约 25–30 路并发，再多就开始排队。

## 九、上线检查清单

| 检查项 | 为什么 |
| --- | --- |
| `--max-model-len` 与实际上下文匹配 | 设太大直接吃掉并发 |
| 服务端硬编码 `max_tokens` 上限 | 防止单请求耗尽 KV |
| `X-Accel-Buffering: no` | 不加就没有流式效果 |
| Nginx 该 location 关 buffering / gzip | 同上 |
| `proxy_read_timeout` > 最长生成时间 | 否则长回答被中途切断 |
| 健康检查用 `/health` 且 `start_period` 给足 | 否则启动期就被判死 |
| 容器日志限制（`max-size`） | 否则磁盘被日志写满，服务全挂 |
| 上游超时 + 客户端断开取消 | 防止 GPU 空转 |
| `terminationGracePeriodSeconds` ≥ 120 | 否则滚动更新切断进行中的对话 |
| 监控 TTFT / TPOT / 队列长度 / KV 使用率 | 只看 GPU 利用率会误判 |

## 小结

整条链路上，真正容易出错的地方不在模型，在**边界**：Nginx 和 FastAPI 之间的缓冲、FastAPI 和 vLLM 之间的超时、前端和 SSE 之间的分帧、上下文和显存之间的预算。

把这四处边界处理干净，一个能用的 AI 聊天机器人其实两三天就能上线。剩下的时间该花在提示词、知识库和评估上——那才是用户真正感知到的部分。
