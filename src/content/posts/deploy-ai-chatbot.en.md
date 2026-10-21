---
title: "Deploying an AI Chatbot from Scratch"
published: 2026-10-20
description: "A deployment path you can copy: vLLM as an OpenAI-compatible server, FastAPI for SSE streaming, the Nginx directives that actually matter, context budgeting, concurrency limits, and how to measure cost. Complete working code plus a launch checklist."
image: ''
tags: [AI Infra, Deployment, FastAPI, Nginx, vLLM]
category: Tech
draft: false
lang: en
---

"Deploy an AI chatbot" sounds like calling an API. In practice, half the time goes to streams that disconnect, Nginx buffering that shows a spinner for ten seconds and then dumps the whole answer at once, and VRAM exploding because the conversation grew too long.

This walks the real order: model server → application layer → gateway → frontend → cost and capacity → launch checklist. Every step ships working configuration.

## 1. Draw the path first

```
browser ──HTTPS──> Nginx ──HTTP──> FastAPI ──HTTP/SSE──> vLLM ──> GPU
                      │                │
                      │                └── auth / rate limit / context trim / logs
                      └── TLS / buffering off / timeouts / static assets
```

The key decision: **split the inference server from the application server**. Inference (vLLM) is heavy, slow to start, VRAM-hungry, expensive to upgrade. The app (FastAPI) is light and changes daily. Bundled into one container, editing a prompt restarts a model and costs three to four minutes of downtime.

## 2. Pick a model and a quantization

Settle three things: hardware, language, acceptable latency.

| Hardware | Model | Quantization | VRAM | Single-stream speed |
| --- | --- | --- | --- | --- |
| 24 GB (4090/L4) | Qwen2.5-7B-Instruct | AWQ INT4 | ~5 GB | 50–70 tok/s |
| 48 GB (L40S/A6000) | Qwen2.5-14B-Instruct | AWQ INT4 | ~9 GB | 35–50 tok/s |
| 80 GB (A100/H100) | Qwen2.5-32B-Instruct | AWQ INT4 | ~19 GB | 25–35 tok/s |
| CPU / Mac | Qwen2.5-7B-Instruct | GGUF Q4_K_M | 5–6 GB RAM | 5–15 tok/s |

For Chinese, prefer the Qwen family — instruction following and phrasing are noticeably more stable than same-size Llama variants. **Do not start at 70B.** A quantized 7B covers most support and Q&A workloads; missing knowledge is better solved with RAG than with more parameters.

Match the format to the engine: vLLM loads AWQ / GPTQ / FP8, llama.cpp loads GGUF. A mismatch produces a wall of shape errors.

## 3. Start the inference server

Compose it, minding `ipc: host` and `--max-model-len`:

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

What the flags mean in practice:

- `--max-model-len 8192`: the hard VRAM budget per request (prompt + output). Raising it to 32768 quadruples KV per session and kills concurrency. The model supporting 32K does not mean you should enable 32K.
- `--max-num-seqs 32`: sequences processed concurrently, the rest queue. Raise it for throughput, accept worse TPOT.
- `--enable-prefix-caching`: from turn two onward, most prefill work is skipped, TTFT drops from hundreds of milliseconds to tens.
- `--api-key`: vLLM's built-in check. Enable it even on localhost so other services in the container network can't call it freely.
- `start_period: 300s`: loading takes minutes; don't let the health check declare death early.

Verify:

```bash
curl -s http://127.0.0.1:8000/v1/chat/completions \
  -H "Authorization: Bearer $LLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"chat","messages":[{"role":"user","content":"Explain KV cache in one sentence"}],"max_tokens":100}'
```

## 4. The application layer: streaming done right

The app has exactly four jobs: assemble messages, trim context, proxy the stream, log metrics. Complete runnable service:

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

MAX_CONTEXT = 6400    # prompt + output budget, ~80% of model limit
MAX_OUTPUT = 1024

app = FastAPI()


def estimate_tokens(text: str) -> int:
    """Rough estimate: ~1 token per CJK char, ~1 token per 4 ASCII chars.
    Production should use the model tokenizer for ~2% error instead of 10-20%."""
    zh = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    other = len(text) - zh
    return zh + other // 4


def trim_history(messages: list[dict], budget: int) -> list[dict]:
    """Keep system messages plus the most recent turns; drop oldest first.
    Must drop in pairs — a dangling assistant message confuses some models."""
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
    # never start with an assistant turn after trimming
    while kept and kept[0]["role"] != "user":
        kept.pop(0)
    return system + kept


@app.post("/api/chat")
async def chat(req: Request):
    body = await req.json()
    messages = body.get("messages", [])
    if not messages:
        raise HTTPException(400, "messages required")

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
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)}, ensure_ascii=False)}\n\n"
        finally:
            ttft = (first_token_at - started) if first_token_at else -1
            print(json.dumps({
                "event": "chat_done",
                "ttft_ms": round(ttft * 1000),
                "total_ms": round((time.time() - started) * 1000),
                "out_chars": out_chars,
                "ctx_tokens": sum(estimate_tokens(m["content"]) for m in messages),
            }))

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # tells Nginx not to buffer — easiest to forget
            "Connection": "keep-alive",
        },
    )
```

Four real traps live in that code:

**Trap 1: `X-Accel-Buffering: no`.** Without it Nginx keeps `proxy_buffering` on, accumulates a full buffer, then flushes. Users watch a spinner for ten seconds and the answer appears in one block — streaming is gone.

**Trap 2: client disconnects.** `StreamingResponse` raises `asyncio.CancelledError` when the client goes away, and by default the upstream httpx request keeps running, burning GPU. Watch `request.is_disconnected()` or at least rely on upstream timeouts.

**Trap 3: `estimate_tokens` is an estimate.** Off by 10%–20%. For precision load the model's tokenizer (`AutoTokenizer`) — just the tokenizer, never the weights, in the app process.

**Trap 4: trimming leaves dangling assistant turns.** Keeping from the tail easily starts the history with an assistant message; some models then hallucinate or error out. Hence the `while kept[0] != "user"` loop.

## 5. Gateway: the three Nginx lines that matter

Proxying SSE is not the same as proxying JSON, so give it a dedicated location:

```nginx
location /api/chat {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;

    # the streaming trio
    proxy_buffering off;
    proxy_cache off;
    gzip off;

    # long-lived: a single answer can take tens of seconds
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

About `proxy_set_header Connection ""`: only needed when using HTTP/1.1 keep-alive upstream, and writing `Connection: close` instead can break SSE outright. The block above works as-is.

Keep gzip off too: compressing SSE makes the compressor wait for enough bytes, which also destroys streaming.

## 6. Frontend: reading the stream correctly

`EventSource` is GET-only and chat needs POST, so use `fetch` plus `ReadableStream`:

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

    // SSE frames split on blank lines; the tail may be partial
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

`decoder.decode(value, { stream: true })` is mandatory. A CJK character is three UTF-8 bytes and will land across chunk boundaries; without the flag you get replacement characters. Likewise the trailing partial frame must be kept in `buffer` rather than discarded, or text goes missing.

## 7. Auth and rate limiting

An exposed chat endpoint needs at least three layers:

```python
from fastapi import Depends, Header, HTTPException
from collections import defaultdict
import time

async def verify(authorization: str = Header("")):
    if authorization != f"Bearer {os.environ['APP_TOKEN']}":
        raise HTTPException(401, "unauthorized")

_hits: dict[str, list[float]] = defaultdict(list)

def rate_limit(key: str, limit: int = 20, window: int = 60):
    now = time.time()
    hits = [t for t in _hits[key] if now - t < window]
    if len(hits) >= limit:
        raise HTTPException(429, "too many requests")
    hits.append(now)
    _hits[key] = hits
```

Third: **a hard server-side output cap**. `max_tokens` must be clamped in the backend; never trust the client. One request with `max_tokens: 100000` can consume the KV cache and take everyone down.

If the bot can fetch URLs or accept uploads, guard against SSRF — reject internal ranges such as `127.0.0.1` and `169.254.169.254`.

## 8. Cost and capacity

Turn cost into a unit price. 7B AWQ on a 4090 (roughly ¥2/hour rented):

```
throughput at full batch: ~800 tok/s
per hour: 800 × 3600 ≈ 2.88M tokens
unit cost: 2 / 2,880,000 × 1000 ≈ ¥0.0007 per 1K tokens
```

Versus commercial APIs, self-hosting only wins under **sustained load**. A few thousand requests a day is cheaper on an API — the card bills hourly whether it's busy or not. Do this arithmetic before building, not after.

Capacity follows the previous article: concurrency is capped by KV cache. 7B, 4K context, 24 GB card ≈ 25–30 concurrent sessions before requests start queueing.

## 9. Launch checklist

| Check | Why |
| --- | --- |
| `--max-model-len` matches real usage | Too high silently kills concurrency |
| Server-side `max_tokens` clamp | One request can exhaust KV |
| `X-Accel-Buffering: no` | Without it there is no streaming |
| Buffering and gzip off for that location | Same reason |
| `proxy_read_timeout` > longest generation | Otherwise long answers get cut off |
| Health check on `/health` with generous `start_period` | Otherwise killed during load |
| Container log limits (`max-size`) | Otherwise logs fill the disk and everything dies |
| Upstream timeout plus disconnect cancellation | Prevents idle GPU burn |
| `terminationGracePeriodSeconds` ≥ 120 | Rolling updates otherwise sever live chats |
| Monitor TTFT / TPOT / queue depth / KV usage | GPU utilization alone misleads |

## Summary

The failures are never in the model. They live on the **boundaries**: buffering between Nginx and FastAPI, timeouts between FastAPI and vLLM, framing between the browser and SSE, budgeting between context and VRAM.

Clean those four boundaries up and a working chatbot ships in two or three days. Spend the remaining time on prompts, retrieval, and evaluation — that's what users actually notice.
