# AI Vision Conversation Assistant

混合流式 AI 视觉对话助手。它不是把连续视频直接丢给一体化实时模型，而是用自建 WebSocket Gateway 编排音频流、语音转写、视觉关键帧、流式 LLM、TTS 和成本控制。

## Architecture

- `frontend`: Vite + React + TypeScript
  - 摄像头预览
  - 麦克风 AudioWorklet PCM 分片
  - Web Speech API 低成本 ASR 兜底
  - 关键帧抽取、画面变化检测
  - LLM 流式文本展示
  - 浏览器 SpeechSynthesis 准流式 TTS
- `backend`: FastAPI + WebSocket + Pipecat-compatible conversation pipeline
  - 自建 Gateway 长连接
  - 流式事件协议
  - Pipecat-ready 对话 pipeline，集中处理 LLM streaming、TTS chunk、history 和 cancel
  - OpenAI-compatible LLM/VL 适配
  - mock fallback，未配置 API Key 也可演示
  - 会话级成本统计、缓存命中、打断取消

## Quick Start

Backend:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Pipecat native modules require Python 3.10+. If you run on Python 3.9, the app
still works through the built-in Pipecat-compatible adapter, but `session.ready`
will report `pipeline.mode=pipecat-compatible-adapter`.

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

## Optional Cloud Models

Copy `.env.example` to `backend/.env` or export the variables before starting the backend.

```bash
export LLM_API_KEY="..."
export LLM_BASE_URL="https://api.deepseek.com"
export LLM_MODEL="deepseek-chat"

export OMNI_API_KEY="..."
export OMNI_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export OMNI_MODEL="qwen3.5-omni-plus"
# Optional fallback when OMNI_MODEL is accidentally set to a Realtime-only model.
export OMNI_CHAT_MODEL="qwen3.5-omni-plus"

export VISION_API_KEY="..."
export VISION_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export VISION_MODEL="qwen-vl-plus"
```

If these are not set, the backend uses local mock streaming so the protocol and UI remain fully testable.

When `OMNI_API_KEY` is configured, text and visual turns use Qwen-Omni directly:
the Gateway buffers recent camera keyframes in memory and the conversation
pipeline sends the latest original frame plus the user question to Qwen-Omni.
This avoids the older summary bottleneck where a separate vision model first
compresses the image into text and the dialogue model answers from that lossy
summary. The Qwen-VL summary path remains available as a fallback when Omni is
not configured.

This code path uses the OpenAI-compatible Chat Completions API. Do not set
`OMNI_MODEL` to a `*-realtime` model unless you also implement the separate
Realtime WebSocket/WebRTC protocol. If a Realtime model is configured by mistake,
the backend falls back to `OMNI_CHAT_MODEL` for this Chat Completions path.

Local account login uses JWT and SQLite by default. For demos, the app can run
with the development defaults; for a shared environment, set:

```bash
export JWT_SECRET_KEY="replace-with-a-long-random-secret"
export DATABASE_PATH="backend/data/app.db"
```

The SQLite store keeps users, conversation metadata, text messages, cost
snapshots, and the latest visual summary. It does not store raw audio,
continuous video, or camera keyframe images.

## Streaming Events

Client to Gateway:

- `audio.input.chunk`
- `browser.asr.partial`
- `browser.asr.final`
- `vision.frame`
- `speech.cancel`
- `session.start`

Gateway to Client:

- `session.ready`
- `asr.partial`
- `asr.final`
- `vision.summary`
- `llm.delta`
- `llm.done`
- `tts.audio.chunk`
- `speech.cancelled`
- `session.cost`
- `error`

## Conversation Pipeline

The backend conversation logic now lives in `backend/app/conversation_pipeline.py`.
The WebSocket Gateway is only responsible for transport and session events;
the pipeline owns:

- LLM token streaming
- sentence-level TTS chunking
- assistant history updates
- cost snapshots
- cancellation boundaries

This keeps the existing browser protocol stable while making the backend ready
to swap in native Pipecat processors/transports on Python 3.10+.

## Design Document

See [docs/design.md](docs/design.md).
