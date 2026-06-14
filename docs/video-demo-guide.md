# Video Demo Guide

## Demo Goal

Show that the app is not just a text chatbot. It is a mixed-stream multimodal assistant that can:

1. Run a realtime camera and microphone session.
2. Answer questions about the current visual scene.
3. Automatically route medication-instruction questions into a safer OCR Agent.
4. Control cost by sending explicit selected frames instead of continuous video or VAD-triggered screenshots.
5. Fail safely when the OCR/model configuration is unavailable or uncertain.

Recommended video length: 3 to 5 minutes.

## Suggested Demo Structure

### 0. Opening Hook: 10-15 seconds

Show the application with camera preview, chat panel, and microphone status visible.

Suggested narration:

> This is a browser-based AI vision conversation assistant. It combines realtime audio, camera-aware visual Q&A, and a specialist medication-instruction Agent for elderly-care scenarios.

Point out:

- Left side: live camera preview.
- Right side: realtime conversation.
- Bottom composer: text, camera, microphone, and mic stream level.

### 1. Realtime Conversation Startup: 30-40 seconds

Action:

1. Start the backend and frontend beforehand.
2. Open `http://127.0.0.1:5173/`.
3. Log in.
4. Start the realtime session with the microphone button.

Suggested narration:

> The browser captures microphone audio through an AudioWorklet and sends it to a FastAPI WebSocket Gateway. The gateway coordinates ASR, model streaming, TTS, recent camera frames, and cost snapshots.

Show:

- Camera preview is active.
- Microphone stream bar moves.
- Realtime status says the conversation is running.

### 2. Explicit Visual Q&A: 45-60 seconds

Action:

1. Turn on the camera preview.
2. Use a visual quick prompt such as `描述画面`, `识别文字`, `检查异常`, or `解释变化`.
3. Alternatively, type a visual question after explicitly choosing the visual action for the turn.

Expected behavior:

- The frontend captures a selected current frame.
- User message appears.
- Assistant answers based on the current camera scene.
- The reply streams in the chat.

Suggested narration:

> For ordinary visual questions, the app does not upload continuous video and does not treat every VAD speech start as a camera event. It sends a selected frame only when the user explicitly chooses a visual action or when the backend Agent requests a frame. That keeps the interaction predictable and lowers model cost.

Call out:

- This is a normal visual Q&A path.
- It is not the medication Agent.
- Camera preview by itself does not upload images.
- Microphone speech by itself does not require images.
- If audio does not play, explain that direct model replies use browser SpeechSynthesis, while Qwen Realtime audio uses a separate audio-delta path.

### 3. Medication Agent Auto-Routing: 60-90 seconds

Prepare:

- Use a non-sensitive medication box, a mock printed label, or a clearly fake demo instruction sheet.
- Do not show private medical information.
- Make sure a visual model/API key is configured if you want a successful OCR demo.

Action:

Say or type:

```text
帮我看一下这个药品说明书。
```

Expected behavior:

1. The system displays a scene switch message.
2. The assistant says or displays guidance:

```text
请把药品说明书、药盒或药瓶标签对准镜头，尽量让药名和用法用量清晰可见。
```

3. The frontend captures a high-quality screenshot.
4. OCR status appears.
5. The model answers based only on OCR text.

Suggested narration:

> This is the key feature. The user does not manually switch modes. The backend detects a conservative medication intent and routes the turn to `MedicationInstructionAgent`. The Agent requests a camera frame, runs OCR, checks OCR quality, and only then asks the model to answer.

Call out safety rules:

- The model must not invent drug names.
- It must not invent dosage or frequency.
- It must say what is unclear.
- It reminds elderly users, children, pregnant users, chronic-disease patients, allergy cases, and combined-medication cases to consult a doctor or pharmacist.

### 4. OCR Safety Failure Case: 30-45 seconds

Action:

Either cover the instruction sheet, show a blank page, or temporarily use a configuration without a valid OCR model.

Ask:

```text
识别这个说明书。
```

Expected behavior:

- The app should not return fake medication content.
- If OCR is unavailable, it says OCR/model configuration is unavailable.
- If the picture is unclear, it asks for a clearer view or exits safely after capped attempts.

Suggested narration:

> Medication is high-risk. A bad answer is worse than no answer. This implementation fails safely. If OCR is unavailable or unreadable, the Agent exits instead of fabricating a drug name or dosage.

### 5. Cost-Control Walkthrough: 40-60 seconds

Action:

Open or point to the app's usage/cost panel if available. If not, explain using the visible flow and code-level behavior.

Suggested narration:

> The app is designed to control operational cost. It does not stream continuous video to a vision model and does not rely on VAD alone to decide that a screenshot is needed. It caches recent frames, deduplicates images by hash, caps OCR retries, and uses browser ASR/TTS where possible. Realtime image append is guarded so provider errors do not trigger unnecessary calls.

Mention actual controls:

- Explicit keyframes, not continuous video.
- VAD controls speech state and interruption; visual capture is a separate product action.
- `realtimeEligible:false` for medication OCR frames.
- `audio_append_seen` guard before Realtime image append.
- Browser ASR/TTS fallback.
- Capped OCR attempts.
- No raw audio/video/image persistence.
- Cost snapshots and usage events.
- The usage page shows aggregate metrics and paginated recent events so the demo does not become a long raw log.

### 6. Closing: 10-15 seconds

Suggested narration:

> The result is a practical multimodal assistant architecture: general realtime video conversation for everyday questions, and a safer specialist Agent for medication instructions. The same Agent runtime can later support fall detection or other elderly-care scenarios.

## Exact Demo Checklist

Before recording:

- Start backend:

```bash
make backend
```

- Start frontend:

```bash
cd frontend
npm run dev -- --host 127.0.0.1 --port 5173
```

- Open:

```text
http://127.0.0.1:5173/
```

- Confirm:

```bash
curl http://127.0.0.1:8000/health
```

- Log in.
- Confirm camera permission is granted.
- Confirm microphone permission is granted.
- Confirm model configuration is valid if showing successful OCR.
- Prepare a safe demo label or fake medication sheet.

## Recommended Demo Prompts

General visual Q&A:

```text
点击“检查异常”，或输入：请基于我刚刚选择的画面检查有没有异常或风险。
```

Scene description:

```text
点击“描述画面”，或输入：请基于当前画面描述主体和明显细节。
```

Medication Agent:

```text
帮我看一下这个药品说明书。
```

Medication follow-up:

```text
那这个是饭前吃还是饭后吃？
```

Safe failure:

```text
识别这个说明书。
```

Use the safe failure prompt while the label is covered or OCR is unconfigured.

## What To Say About Audio

There are two audio paths:

- Qwen Realtime responses may arrive as model audio chunks.
- Direct model and Agent responses arrive as text chunks plus browser SpeechSynthesis playback.

Suggested explanation:

> The app separates the voice path from the reasoning path. Realtime audio is used when the provider emits audio chunks. Direct visual Q&A and Agent responses stream text first and can be spoken through browser TTS. This keeps the system portable and lowers cost, but the production version should make the voice path more explicit.

## What Not To Demo

- Do not use a real private prescription or personal health record.
- Do not claim the app gives medical advice.
- Do not claim it can replace a doctor or pharmacist.
- Do not show the app inventing dosage from unclear images.
- Do not rely on provider error banners; non-actionable Realtime provider errors are intentionally hidden.

## Common Failure Modes and Presenter Script

### OCR says unavailable

Cause:

- No visual model API key.
- Wrong model configured.
- Network/provider error.

Script:

> This is the safe failure path. The system refuses to fabricate OCR text and asks for configuration or a retry.

### OCR asks for retake

Cause:

- Low text quality.
- Missing drug or usage hints.

Script:

> The Agent checks whether the OCR contains enough medication evidence. If not, it asks for a clearer frame instead of guessing.

### Text appears but no model audio

Cause:

- The current path may be direct model plus browser TTS rather than Qwen Realtime model audio.

Script:

> The text stream is the source of truth. In this prototype, browser TTS handles some direct and Agent responses, while Realtime provider responses use audio delta events.

### General visual answer is not precise

Cause:

- The selected camera frame may be blurry, cropped, or semantically ambiguous.
- The user may have asked a text-only turn without explicitly sending a visual frame.

Script:

> The app is using explicit selected keyframes, not continuous video. For precise visual work, we ask the user to center the target and trigger a fresh visual action.

### Realtime reports "append image before append audio"

Cause:

- A provider session received an image before any audio append.
- This is most likely when an image is sent too early in a newly opened Realtime session.

Script:

> Realtime providers can require audio before image input. The Gateway tracks `audio_append_seen` and should defer or skip image append until audio is ready. For demos, use explicit visual actions after the session is running, or use the Agent OCR path where frames are marked `realtimeEligible:false`.

## Suggested Screen Recording Order

1. Show app home and camera preview.
2. Start realtime session.
3. Trigger one explicit visual quick prompt.
4. Ask medication instruction question.
5. Show scene switch and OCR status.
6. Show safe medication answer based on OCR.
7. Ask one follow-up.
8. Show safe failure by hiding the label or using unavailable OCR.
9. Close with cost-control summary.
