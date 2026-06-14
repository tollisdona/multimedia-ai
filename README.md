# AI Vision Conversation Assistant

混合流式 AI 视觉对话助手。项目用 React 前端和 FastAPI WebSocket Gateway 编排摄像头、麦克风、实时语音、显式视觉截图、多模态模型、浏览器 TTS、会话持久化和成本统计。

当前版本在普通视频对话之外，新增了一个可扩展的 Agent 子系统。首个子 Agent 是“药品说明书识别”：用户说“帮我看药品说明书 / 这个药怎么吃”时，系统自动切换场景、请求高质量截图、调用 OCR，并要求模型只基于 OCR 文本回答。

## Features

- 实时视频预览和麦克风状态展示
- WebSocket Gateway 流式事件协议
- Qwen Realtime 音频会话接入，并保留浏览器 ASR 兜底
- 普通视觉问答：用户显式触发时截图、缓存最近关键帧、用 OpenAI-compatible Chat Completions 回答
- 药品说明书 Agent：保守意图识别、后端请求截图、Qwen-VL 文档式 OCR、OCR 质量门、短期追问上下文
- 安全回答约束：药品回答只基于 OCR 文本，不补全药名、剂量、频次、禁忌
- Realtime 安全保护：音频 append 前不向 Qwen Realtime append 图片，药品 OCR 图片默认不进入 Realtime image buffer
- 用户可见的模型处理状态：场景切换、OCR 中、重拍尝试、流程退出
- 浏览器 SpeechSynthesis TTS，用于 direct model 和 Agent 文本回复
- SQLite 会话、消息、成本快照和使用统计
- 成本控制：关键帧缓存、非连续视频上传、打断取消、TTS 字符统计、token 估算

## Interaction Policy

The current product policy is explicit visual input by default:

- Opening the camera only enables local preview; it does not mean every message includes an image.
- VAD detects speech lifecycle and supports barge-in, but VAD `speechStart` should not automatically capture camera frames.
- Ordinary text or voice turns are sent as text/audio unless the user explicitly chooses a visual action.
- Visual frames should be sent when the user clicks a visual quick prompt, chooses a "send with image" style action, or when a backend Agent emits `vision.capture.request`.
- Broad keyword matching such as `看`, `这个`, or `那个` is intentionally avoided as the main trigger because it causes false positives in Chinese conversation.
- Realtime image append is guarded by `audio_append_seen`; if a Qwen Realtime session has not received audio yet, images are cached/deferred rather than appended to the provider.

## Architecture

```text
frontend/src/App.tsx
  camera preview + manual text + browser ASR/TTS + AudioWorklet PCM
        |
        | WebSocket events
        v
backend/app/gateway.py
  transport, session lifecycle, frame cache, realtime guard
        |
        v
backend/app/conversation_pipeline.py
  intent routing, direct model streaming, TTS chunks, Agent runtime
        |
        +--> backend/app/medication_agent.py
        |      request frame -> OCR -> quality gate -> answer from OCR
        |
        +--> backend/app/ai.py
               OpenAI-compatible Chat Completions streaming
```

Backend modules:

- `backend/app/gateway.py`: WebSocket Gateway, camera frame cache, audio forwarding, Realtime safety guard.
- `backend/app/realtime.py`: Qwen Realtime provider wrapper; suppresses non-actionable provider noise.
- `backend/app/conversation_pipeline.py`: turn-level pipeline; routes to specialist Agents or normal direct model flow.
- `backend/app/agent_runtime.py`: lightweight Agent runtime contracts.
- `backend/app/medication_intent.py`: conservative medication intent and follow-up detection.
- `backend/app/medication_agent.py`: medication instruction Agent workflow.
- `backend/app/medication_ocr.py`: Qwen-VL document OCR provider and safe unavailable fallback.
- `backend/app/db.py`: SQLite persistence for users, conversations, messages, costs, and usage events.

Frontend modules:

- `frontend/src/App.tsx`: main UI, WebSocket event handling, camera capture, TTS playback, chat history.
- `frontend/src/lib/audioCapture.ts`: AudioWorklet PCM capture and optional TTS suppression gate.
- `frontend/src/types.ts`: Gateway event union.

## Quick Start

Backend:

```bash
make backend
```

This creates `backend/.venv` if needed, installs dependencies, initializes SQLite on startup, and starts FastAPI at:

```text
http://localhost:8000
```

Override host or port:

```bash
BACKEND_HOST=127.0.0.1 BACKEND_PORT=9000 make backend
```

Force backend dependency reinstall:

```bash
make backend-reinstall
```

Manual backend startup:

```bash
cd backend
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Frontend:

```bash
cd frontend
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

Open:

```text
http://127.0.0.1:5173
```

Health check:

```bash
curl http://127.0.0.1:8000/health
```

## Model Configuration

The backend reads model settings from the logged-in user's saved configuration first, then from environment defaults.

Common environment variables:

```bash
export OMNI_API_KEY="..."
export OMNI_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export OMNI_MODEL="qwen3.5-omni-plus"
export OMNI_CHAT_MODEL="qwen3.5-omni-plus"

export OMNI_REALTIME_ENABLED="true"
export OMNI_REALTIME_BASE_URL="wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
export OMNI_REALTIME_MODEL="qwen-omni-turbo-realtime"
export OMNI_REALTIME_VOICE="Cherry"
```

Medication OCR uses the same OpenAI-compatible visual chat configuration through `QwenVlDocumentOcrProvider`. The OCR prompt asks the model to return strict JSON with:

- `full_text`
- `key_sections`
- `uncertain_parts`

If no usable visual model/API key is configured, OCR now fails safely with `ocr-unavailable`. It does not fabricate demo text or return fake drug names.

## Runtime Modes

The project keeps a Pipecat-compatible pipeline boundary but does not require native Pipecat at runtime. On Python 3.9, `session.ready.capabilities.pipeline.mode` reports:

```text
pipecat-compatible-adapter
```

On Python 3.10+ with native Pipecat installed, this boundary can be replaced by native processors without changing the frontend wire protocol.

## Streaming Events

Client to Gateway:

- `session.start`
- `session.voice.update`
- `audio.input.chunk`
- `browser.asr.partial`
- `browser.asr.final`
- `vision.frame`
- `vision.capture.failed`
- `vision.clear`
- `speech.cancel`

Gateway to Client:

- `session.ready`
- `session.started`
- `voice.updated`
- `asr.partial`
- `asr.final`
- `vision.frame.cached`
- `vision.frames.cleared`
- `scene.switched`
- `agent.guidance`
- `vision.capture.request`
- `ocr.started`
- `ocr.result`
- `ocr.retake.requested`
- `agent.exited`
- `llm.delta`
- `llm.done`
- `response.text.delta`
- `response.audio.delta`
- `response.audio.done`
- `tts.audio.chunk`
- `speech.cancelled`
- `session.cost`
- `error`

## Medication Instruction Agent

Trigger examples:

- `这个药怎么吃`
- `帮我看药品说明书`
- `药盒上的用法用量是什么`
- `识别这个说明书`

Non-triggers:

- `帮我看看这个`
- `识别文字`
- `看一下说明`

Flow:

1. `ConversationPipeline` checks medication intent before normal model routing.
2. `MedicationInstructionAgent` emits `scene.switched` and `agent.guidance`.
3. Backend emits `vision.capture.request`.
4. Frontend captures a high-quality image with `realtimeEligible:false`.
5. OCR provider extracts document text.
6. Quality gate checks text length, drug/usage hints, confidence, and OCR availability.
7. Accepted OCR text and the captured image are passed to the answer model with strict medication safety constraints.
8. Follow-up context is kept for 3 minutes or 3 turns.

Safety behavior:

- OCR images do not enter Qwen Realtime image buffer.
- No fake OCR data is used in user-facing medication answers.
- Missing or uncertain drug information is surfaced as uncertainty.
- Elderly, children, pregnancy, chronic disease, allergy, and combined medication cases are reminded to consult a doctor or pharmacist.

## Cost Controls

Implemented controls:

- No continuous video upload; only explicit screenshots/keyframes are sent.
- Reuse recent frame hashes and count cache hits.
- Do not append images to Realtime before audio append has been observed.
- Medication OCR frames bypass Realtime and go only to the Agent/OCR tool chain.
- VAD is treated as an audio control signal, not as the default visual capture trigger.
- Browser Web Speech API and browser SpeechSynthesis are used where possible.
- Direct model output is streamed and split into sentence-level TTS chunks.
- User interruption cancels pending generation and speech playback.
- Raw audio/video/images are not persisted to SQLite.
- Conversation history and frame buffers are bounded.
- Non-actionable Realtime provider errors are hidden from the user.

## Local Data

SQLite stores:

- users
- model configuration metadata
- conversations
- text messages
- cost snapshots
- usage events

SQLite does not store raw microphone audio, continuous video, or camera image data.

## Testing

Backend tests:

```bash
PYTHONPATH=backend backend/.venv/bin/python -m unittest discover -s backend/tests -v
```

Backend syntax check:

```bash
backend/.venv/bin/python -m py_compile backend/app/*.py
```

Frontend build:

```bash
cd frontend
npm run build
```

## Documentation

- [Design review and implementation notes](docs/design-review.md)
- [Video demo guide](docs/video-demo-guide.md)
- [Medication Agent coding plan](docs/medication-agent-coding-plan.md)
- [Original architecture design](docs/design.md)
