# Design Review: User Stories, Implementation, and Cost Controls

## Purpose

This document summarizes the intended product scope and what was actually implemented in the current local application. It also records the cost-control ideas considered during design and the subset that made it into the product.

The application is a mixed-stream multimodal assistant: it supports realtime audio/video conversation, ordinary visual Q&A, and an automatic medication-instruction OCR Agent.

## Planned User Stories

### Core Conversation

- As a user, I want to sign in and resume prior conversations, so that demo history and costs are not lost after refresh.
- As a user, I want to open the camera and microphone from the browser, so that I can talk while the assistant sees my current scene.
- As a user, I want my speech to become text in the chat, so that I can confirm what the system understood.
- As a user, I want the assistant to stream its answer, so that the interface feels responsive.
- As a user, I want the assistant response to be spoken, so that the product feels like a realtime assistant instead of a text-only chat.
- As a user, I want to interrupt the assistant, so that I can correct it or move to the next question.

### Visual Q&A

- As a user, I want to ask about the current camera view, so that I do not need to upload files manually.
- As a user, I want quick visual prompts, so that I can test common visual tasks such as describing the scene, reading text, checking risk, and explaining changes.
- As a user, I want the app to avoid sending every video frame, so that the demo remains fast and affordable.

### Medication Instruction Agent

- As an elderly-care or caregiving user, I want to ask "how do I take this medicine?" and have the system automatically switch to medication-instruction mode.
- As a user, I want the assistant to guide me to point the drug label or instruction sheet at the camera.
- As a user, I want the system to capture the image and run OCR automatically, so that I do not need to manually upload a screenshot.
- As a user, I want medication answers to be based only on visible/OCR text, so that the assistant does not hallucinate drug names, dosage, frequency, or contraindications.
- As a user, I want the assistant to admit uncertainty and ask for a better view when OCR is unclear.
- As a user, I want follow-up questions such as "before or after meals?" to reuse the last OCR context for a short time.

### Safety, Reliability, and Cost

- As a user, I do not want low-level provider errors such as "append image before append audio" to appear in the UI when they are not actionable.
- As a user, I want the app to fail safely when OCR is not configured, rather than returning fake demo medication content.
- As a demo presenter, I want the app to respond quickly even if the OCR scene is imperfect.
- As an operator, I want visible cost metrics for audio chunks, speech seconds, image frames, token estimates, TTS characters, and interruptions.

## Implemented User Stories

### Implemented: Core Conversation

- Login, conversation listing, message persistence, and SQLite-backed conversation metadata are implemented.
- Browser camera preview and microphone access are implemented.
- AudioWorklet captures PCM chunks and sends them over WebSocket.
- Browser Web Speech API is used as an ASR fallback; Qwen Realtime can also produce realtime ASR events.
- Model text streams through `llm.delta` or `response.text.delta`.
- Browser SpeechSynthesis can play `tts.audio.chunk` responses for direct model and Agent paths.
- Qwen Realtime audio chunks can play through `response.audio.delta`.
- User cancellation sends `speech.cancel` and stops pending browser/model audio.

### Implemented: Visual Q&A

- Frontend can capture camera frames for semantic visual questions.
- Backend caches recent frames in session memory and deduplicates repeated images by hash.
- The normal conversation path can send the latest frame plus text to an OpenAI-compatible multimodal model.
- Visual quick prompts exist under the video preview.
- Frame upload is guarded so image append to Qwen Realtime only happens after audio append has been observed.

### Implemented: Medication Instruction Agent

- `MedicationInstructionAgent` is implemented as a specialist under `ConversationPipeline`.
- Conservative medication intent detection is implemented in `medication_intent.py`.
- The Agent emits `scene.switched`, `agent.guidance`, `vision.capture.request`, `ocr.started`, `ocr.result`, `ocr.retake.requested`, and `agent.exited`.
- The frontend responds to `vision.capture.request` by sending a high-quality `vision.frame` with `realtimeEligible:false`.
- Qwen-VL-style document OCR is implemented through an OpenAI-compatible chat-completions call.
- OCR output is parsed as structured JSON and normalized into `MedicationOcrResult`.
- OCR quality gates check for empty text, medication hints, usage hints, low confidence, and unavailable OCR.
- OCR unavailable or failed paths are safe: they return no fake medication text and exit without repeated retakes.
- Accepted OCR text and the captured image are passed into a medication-specific multimodal answer prompt that forbids unsupported completion of missing drug facts.
- Follow-up context is kept for 3 minutes or 3 follow-up turns.

### Implemented: Safety and Error Handling

- Medication OCR screenshots do not enter Qwen Realtime image buffer.
- `audio_append_seen` prevents appending images before any audio has been sent to a Realtime session.
- Reconnect and close reset `audio_append_seen`.
- Non-actionable Realtime noise errors are suppressed before reaching the user.
- Browser TTS playback suppresses ASR/VAD/microphone streaming briefly, reducing self-interruption.
- The app no longer displays fake "sample drug" OCR output when OCR is unconfigured.

### Partially Implemented or Deferred

- Native Pipecat runtime is not active on Python 3.9; the project uses a Pipecat-compatible adapter boundary.
- LangChain was not added because the current Python runtime is 3.9. The Agent interface was kept stable so LangChain can replace the internal executor later on Python 3.10+.
- PaddleOCR is not integrated yet. The OCR provider interface allows adding it later.
- Visual quick prompts still behave like direct text turns. They are useful for demos, but the audio path needs a product decision: keep them as text/browser-TTS prompts, or remove them to reduce confusion with Realtime audio.
- No production alerting, distributed tracing, Redis cache, or multi-worker session store has been added.

## Cost-Control Ideas Considered

- Do not upload continuous video; upload only selected frames.
- Use browser ASR when possible instead of paid cloud ASR.
- Use browser SpeechSynthesis when possible instead of paid cloud TTS.
- Hash frames and skip duplicate image model calls.
- Keep a small in-memory frame buffer and avoid persisting images.
- Trigger visual capture only when there is visual intent.
- Use conservative Agent routing to avoid accidentally running OCR.
- Use smaller OCR screenshots during demos to reduce upload and inference latency.
- Cancel model generation and TTS immediately when users interrupt.
- Limit follow-up context and history passed to models.
- Track estimated tokens, image counts, audio seconds, TTS characters, and interruptions.
- Suppress non-actionable provider errors instead of retrying expensive operations blindly.
- Separate normal Realtime conversation from tool/OCR image processing.
- Use a cheap OCR provider first and reserve stronger models for hard cases.
- Cache OCR results for short follow-up turns.
- Add per-user/session quotas and rate limits.
- Batch or queue slow visual/OCR tasks in production.
- Use local OCR such as PaddleOCR for repeatable document extraction.

## Cost Controls Actually Adopted

- Keyframe-based visual upload rather than continuous video upload.
- Recent-frame memory cache and frame hash deduplication.
- Medication OCR frames marked `realtimeEligible:false`, preventing duplicate image routing into Realtime.
- Realtime image append is gated by `audio_append_seen`.
- Browser Web Speech API fallback is used for low-cost ASR.
- Browser SpeechSynthesis is used for direct model and Agent TTS chunks.
- Direct model output is streamed and split into sentence chunks for early TTS playback.
- User interruptions cancel current generation and speech playback.
- Medication follow-up context is bounded to 3 minutes or 3 turns.
- OCR retries are capped to 3 attempts in the faster demo profile.
- OCR image payload is capped and resized before upload.
- OCR unavailable fails safely without spending answer-model tokens on fake OCR.
- Non-actionable Realtime provider errors are suppressed.
- SQLite stores text and cost metadata, not raw audio/video/image data.
- Cost snapshots and usage events are recorded for visibility.

## Cost Controls Still Recommended

- Add explicit per-user quotas for image calls, OCR calls, and Realtime minutes.
- Add a provider-level cost policy, for example "cheap OCR first, strong model second."
- Add OCR result caching keyed by image hash.
- Add server-side image compression and document crop preprocessing.
- Add Redis for session state and rate-limit counters.
- Add background queues for OCR and large visual calls.
- Add dashboards for real provider usage, estimated usage, and model-level cost.

## Final Assessment

The implemented product covers the main demo story: realtime multimodal chat plus a socially valuable medication-instruction Agent. The implementation prioritizes safety and cost over maximal automation. The biggest product tradeoff is that multiple audio paths now coexist:

- Qwen Realtime audio for Realtime provider responses.
- Browser SpeechSynthesis for direct model and Agent responses.

That split is acceptable for a prototype, but a production product should make the voice path more explicit in the UI or unify playback through one TTS provider.
