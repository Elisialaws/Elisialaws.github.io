---
title: "AI Infra: The Memory Ledger Behind Every Inference Service"
published: 2026-10-19
description: "Turning \"let's self-host a model\" into arithmetic — how much VRAM weights, KV cache and workspace each take, why decode is bandwidth-bound, what PagedAttention and continuous batching actually fix, and how to size GPUs from QPS."
image: ''
tags: [AI Infra, Inference, vLLM, GPU]
category: Tech
draft: false
lang: en
---

"We want to self-host a model" usually comes with a set of numbers nobody has calculated: do we have enough VRAM, how many users can it serve at once, how many tokens per second per card, and why does a 7B model fit in 24 GB but only serve one person.

Most of AI infrastructure work is doing that arithmetic properly, then making sure no byte of memory and no slice of bandwidth sits idle. This article goes in order: count the memory, find the bottleneck, pick an engine, size the fleet.

## 1. Open the memory ledger

One inference request touches exactly three things:

```
VRAM = weights + KV cache × concurrent sequences + workspace
```

### 1.1 Weights: parameters × bytes per parameter

| Precision | Bytes/param | 7B actual | 70B actual | Notes |
| --- | --- | --- | --- | --- |
| FP32 | 4 | 28 GB | 280 GB | Training, rarely inference |
| BF16 / FP16 | 2 | 14 GB | 140 GB | The baseline |
| INT8 (W8A8) | 1 | 7 GB | 70 GB | Small quality loss, needs calibration |
| INT4 (AWQ/GPTQ) | ~0.5 | 3.5–4.5 GB | 35–45 GB | Group scales add overhead |

Two details that bite:

**Quantization is not a clean division by two.** AWQ stores a scale and zero per group of 128 weights, so real size is about 1.05–1.15× the theoretical INT4 number. That 7B "3.5 GB" lands at 4.1–4.3 GB on disk.

**Loading needs headroom.** Reading weights into VRAM creates a transient peak; `--gpu-memory-utilization 0.95` can OOM during loading, before serving a single token.

### 1.2 KV cache: the real consumer

During autoregressive decoding, every generated token must keep its Key and Value for every layer, otherwise the next token requires recomputing the entire prefix. Per token:

```
bytes/token = 2 × layers × kv_heads × head_dim × bytes_per_element
```

For Llama-3-8B — 32 layers, 8 KV heads (GQA), head_dim 128, FP16:

```
2 × 32 × 8 × 128 × 2 = 131,072 bytes = 128 KiB / token
```

So a single 8K-context conversation costs 8,192 × 128 KiB = **1 GiB** of KV cache.

This is why a 24 GB card running 7B FP16 (14 GB of weights) has roughly 10 GB left, and after workspace only fits 7–8 concurrent 8K sessions. **Concurrency is not limited by compute. It is limited by KV cache.**

GQA is the single most important optimization here. Llama-3-8B's 32 attention heads share 8 KV groups, cutting KV volume to a quarter of MHA. With plain MHA, the same card would hold only two 8K sessions.

### 1.3 Workspace: don't skip that 10%

CUDA kernel scratch buffers, attention intermediates, CUDA Graph capture space, the PyTorch caching allocator — all of it counts.

Rule of thumb: reserve 8%–15% beyond weights plus KV. `--gpu-memory-utilization 0.90` means exactly that: give 90% to the engine, leave the rest for context switching and fragmentation.

Fragmentation is the invisible cost. After dozens of requests of varying length, VRAM develops holes, and a long request may fail to allocate even when total free memory is sufficient. That is what PagedAttention solves.

## 2. Where is the bottleneck?

Inference has two phases with completely different bottlenecks:

| Phase | What happens | Bound by | Key metric |
| --- | --- | --- | --- |
| Prefill | Processes the whole prompt at once | Compute (dense matmul) | TTFT |
| Decode | Emits one token at a time | Memory bandwidth (read all weights per step) | TPOT |

Decode is almost embarrassingly simple: each token requires streaming the entire model's weights from HBM through the SMs. Its ceiling is bandwidth, not FLOPS:

```
single-sequence decode ceiling ≈ memory bandwidth / weight size
```

7B FP16 (14 GB of weights) on two common cards:

| GPU | Bandwidth | Theoretical | Measured (batch=1) |
| --- | --- | --- | --- |
| A100 80G | 2.0 TB/s | ~143 tok/s | 90–110 tok/s |
| H100 SXM | 3.35 TB/s | ~240 tok/s | 160–200 tok/s |

Seventy percent of theoretical is normal — kernel launch overhead, quantization round-trips, sampling, scheduling all take a cut.

Two engineering decisions follow directly:

**Batching is nearly free.** At batch=1 the weights are read once to produce one token. At batch=32 the same read produces 32 tokens, amortizing bandwidth 32× and raising aggregate throughput by an order of magnitude. The cost is that each sequence reserves its own KV.

**Quantization helps decode far more than prefill.** Decode is bandwidth-bound; halving weight bytes from 2 to 1 nearly doubles speed. This is why INT4 is non-negotiable on consumer cards.

## 3. Choosing an engine

A hand-rolled `model.generate()` loop is fine for a demo and falls apart under concurrency: preallocated buffers for max length, no interleaving between requests, one long request blocking everything behind it. Production uses a dedicated engine.

| Engine | Strength | Fits | Caveat |
| --- | --- | --- | --- |
| **vLLM** | PagedAttention, continuous batching, largest ecosystem | General self-hosting, OpenAI-compatible API | Fast-moving; flags get renamed |
| **SGLang** | RadixAttention prefix sharing, fast structured output | Multi-turn chat, shared system prompts | Narrower ecosystem |
| **TensorRT-LLM** | Peak performance, fused kernels | Fixed model, fixed shape | Heavy build step; recompile per change |
| **llama.cpp** | Runs on CPU/Metal, GGUF ecosystem | Edge devices, Macs, local trials | Not built for high concurrency |
| **Ollama** | One command, great DX | Local dev, internal tools | Weak production observability |

One-liner: **vLLM for fast and boring, SGLang when prefixes repeat heavily, TensorRT-LLM when the model is frozen and you want every FLOP, llama.cpp when there's no GPU.**

## 4. Four techniques that actually moved the needle

### 4.1 PagedAttention: KV cache as virtual memory

Classic implementations preallocate a contiguous block sized to `max_seq_len` per request. Three requests at 8K lock 3 GiB even if each uses 500 tokens. Real waste runs 60%–80%.

PagedAttention borrows the OS paging idea: split KV cache into fixed blocks (vLLM defaults to 16 tokens), and map logical to physical via a block table.

- Allocate on demand; waste drops below 4%
- Blocks need not be contiguous, so fragmentation disappears
- Requests sharing a prefix share physical blocks

This is why vLLM serves 2–4× the concurrency on identical hardware.

### 4.2 Continuous batching

Static batching waits for a full batch, runs it, returns together — fast requests pay for slow ones. Continuous batching recomposes the batch at **every decode step**: finished sequences release their slot, queued requests join immediately.

Short requests stop waiting behind long ones, and the batch stays full. Second-largest throughput win.

### 4.3 Chunked prefill

A 32K prompt's prefill monopolizes the GPU for tens to hundreds of milliseconds. During that window every decoding request stalls — users see typing suddenly freeze.

Chunked prefill splits long prompts and mixes the pieces with decode work in the same batch. Long prompts pay slightly higher TTFT; everybody's TPOT becomes stable.

### 4.4 Prefix caching

In multi-turn chat, each turn re-prefills the entire history, though the system prompt and prior turns are byte-identical.

Prefix caching hashes computed KV blocks and reuses them on hit. By turn two of a 10K-context conversation you skip most of the prefill, dropping TTFT from hundreds of milliseconds to tens. Flag in vLLM: `--enable-prefix-caching`.

### 4.5 Speculative decoding

A small draft model (or an extra prediction head) guesses 4–8 tokens; the large model verifies them in one forward pass and keeps the matching prefix.

Payoff is task-dependent: code completion and structured output can hit 2–3×, free-form prose maybe 1.1× because rejected drafts must be rolled back. It also consumes extra VRAM, and at high concurrency the added pressure can reduce aggregate throughput.

**Verdict: worth it at low concurrency, usually not worth it when chasing total throughput.**

## 5. Sizing GPUs from QPS

The practical part. Given business targets, work backwards:

```
concurrent sessions N = QPS × average session duration
KV per session         = context length × bytes/token
total KV               = N × KV per session
```

Concrete example:

- 7B AWQ INT4, ~4 GB weights
- Average context 4K, 128 KiB/token → 512 MiB per session
- Target 30 concurrent sessions
- 24 GB card (4090 / L4)

```
usable KV VRAM = 24 × 0.90 − 4 (weights) − 2 (workspace) ≈ 15.6 GB
KV demand      = 30 × 0.5 GB = 15 GB
```

That is right at the edge, with no headroom for spikes. Either cut context to 3K, move to a 48 GB card, or run two nodes.

Now throughput. 7B INT4 on an L4 (300 GB/s), 4 GB of weights:

```
single-sequence ceiling ≈ 300 / 4 = 75 tok/s
aggregate at batch=16 ≈ 500–700 tok/s (compute-limited, not linear)
```

At 300 output tokens per user, one card carries roughly 1.7–2.3 requests/second of decode throughput. That is the number capacity planning actually needs.

:::tip
Treat context length as the dominant cost parameter. At the same 30 concurrent sessions, going from 8K to 2K cuts KV demand by 4× — one card does the work of four. Most products do not need 8K of chat history; **trimming history is far cheaper than buying GPUs**.
:::

## 6. Multi-GPU: TP, PP, EP

When one card isn't enough, there are exactly three options:

| Mode | Splits | Traffic | Fits |
| --- | --- | --- | --- |
| **TP** (tensor parallel) | Each layer's weight matrices, by row/column | Two all-reduces per layer — highest | Intra-node, needs NVLink |
| **PP** (pipeline parallel) | Layers across devices | Activations at layer boundaries — low | Cross-node, PCIe |
| **EP** (expert parallel) | MoE experts across devices | All-to-all, routing-dependent | MoE models |

The trade-offs are clear:

- **Same node → TP**, because all-reduce runs over NVLink (900 GB/s) instead of PCIe (64 GB/s). TP=8 on a single 8-GPU node is standard.
- **Cross-node → PP**, low traffic, paid for in pipeline bubbles. More micro-batches shrink the bubbles.
- **MoE → EP**. Models like DeepSeek have huge total parameter counts but small activations; EP lets each card hold a subset of experts, far more efficient than TP over dense layers.

One commonly missed point: **TP makes latency worse.** TP=4 means two extra all-reduce waits per layer; decode TPOT can go from 20 ms to 30 ms. Multiple GPUs buy VRAM and throughput, not single-request speed.

## 7. Containerizing it

The official vLLM image is enough; the flags are what matter:

```bash
docker run -d --gpus all --ipc=host --name llm \
  -p 8000:8000 \
  -v /data/models:/models \
  vllm/vllm-openai:latest \
  --model /models/Qwen2.5-7B-Instruct-AWQ \
  --quantization awq \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.90 \
  --max-num-seqs 64 \
  --enable-prefix-caching \
  --served-model-name chat
```

- `--ipc=host`: vLLM passes tensors through shared memory; without host IPC you get `Bus error` or a silent hang.
- `--max-model-len`: **do not set it to the model maximum.** At 8192 each request reserves up to 1 GiB of KV; at 32768 that becomes 4 GiB and concurrency collapses.
- `--max-num-seqs`: the knob trading latency against throughput.
- `--gpu-memory-utilization`: 0.90 is stable; 0.95 OOMs under long context.

Do not use `/v1/models` for health checks — it answers before weights finish loading. vLLM exposes `/health`, which returns 200 only after loading:

```yaml
startupProbe:
  httpGet: { path: /health, port: 8000 }
  failureThreshold: 60
  periodSeconds: 5      # loading can take 2-5 minutes
livenessProbe:
  httpGet: { path: /health, port: 8000 }
  periodSeconds: 15
```

On Kubernetes there are two more traps:

**Rolling updates kill long-lived connections.** An SSE stream can run for tens of seconds; the default 30-second `terminationGracePeriodSeconds` lands right in the middle. Set 120–300 and add a preStop sleep after deregistering.

**GPU nodes cannot be casually evicted.** Reloading a model takes minutes, so one eviction equals minutes of downtime. Add a `priorityClass`, or skip orchestration and use bare metal with systemd.

## 8. Metrics that matter after launch

| Metric | Meaning | Healthy (reference) |
| --- | --- | --- |
| TTFT P95 | Time to first token | < 800 ms |
| TPOT P95 | Time per output token | < 50 ms (~20 tok/s) |
| Queue wait | Time spent in the scheduler | < 100 ms |
| KV cache usage | Share of KV memory in use | 60%–85%; sustained >95% means expand |
| running / waiting | Active vs queued requests | waiting > 0 sustained means undersized |
| tokens/s per GPU | Per-card throughput | Unit economics |
| SM utilization | Compute occupancy | Low during decode is normal |

That last row misleads people constantly: **10%–30% SM utilization during decode is expected**, because the bottleneck is bandwidth. Teams that treat low SM usage as idle capacity make bad scaling decisions. Watch KV usage and the waiting queue instead.

## 9. Trap list

In the order I hit them:

1. **Context length set too high**, concurrency collapses. Compute KV first, then pick `--max-model-len`.
2. **Prefix caching off**, multi-turn chats recompute prefixes, TTFT inexplicably terrible.
3. **Probes hitting unready Pods**, every request gets a 503. Use `/health` plus `startupProbe`.
4. **Forgot `--ipc=host`**, the container dies silently seconds after start.
5. **Quantization format mismatched**, AWQ weights loaded by a GPTQ loader, endless shape errors.
6. **TP over PCIe**, cross-NUMA traffic drags scaling efficiency to 0.6 — four cards perform like two.
7. **No concurrency limit at launch**, one crawler fills the queue and every real user times out.
8. **Monitoring GPU utilization but not the queue**, so scaling is always one step behind.

## Summary

Four sentences:

- VRAM = weights + KV + workspace, and **concurrency is set by KV, not compute**.
- Prefill is compute-bound, decode is bandwidth-bound, and **batching in decode is nearly free**.
- Throughput comes from PagedAttention, continuous batching, prefix caching; speculative decoding pays only at low concurrency.
- Capacity planning starts from QPS and context length — **shrink context before buying cards**.

There is no magic in AI infrastructure, only arithmetic. Get the arithmetic right and the rest is configuration.
