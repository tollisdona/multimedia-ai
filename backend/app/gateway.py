from __future__ import annotations

import asyncio
import base64
from contextlib import suppress
from typing import Any
from uuid import uuid4

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from .ai import frame_hash
from .conversation_pipeline import ConversationPipeline, pipecat_runtime_status
from .db import append_message, enqueue_usage_event, save_cost_snapshot
from .medication_intent import detect_medication_intent
from .model_config import runtime_model_config_for_user
from .models import FrameSnapshot, SessionState, event, now_ms
from .realtime import QwenRealtimeProvider, realtime_available


class GatewayConnection:
    def __init__(self, websocket: WebSocket, user_id: str, conversation_id: str) -> None:
        self.websocket = websocket
        model_config = runtime_model_config_for_user(user_id)
        self.session = SessionState(user_id=user_id, conversation_id=conversation_id, model_config=model_config)
        self.pending_capture_requests: dict[str, asyncio.Future[FrameSnapshot | None]] = {}
        self.pipeline = ConversationPipeline(self.session, emit=self.send_provider_event, request_frame=self.request_agent_frame)
        self.generation_task: asyncio.Task[None] | None = None
        self.send_lock = asyncio.Lock()
        self.realtime = (
            QwenRealtimeProvider(
                self.session,
                self.send_provider_event,
                self.record_realtime_user_transcript,
                self.record_realtime_assistant_transcript,
                model_config,
            )
            if model_config and realtime_available(model_config)
            else None
        )

    async def send(self, event_type: str, **payload: Any) -> None:
        async with self.send_lock:
            await self.websocket.send_json(event(event_type, sessionId=self.session.session_id, **payload))

    async def send_cost(self) -> None:
        snapshot = self.session.cost.snapshot()
        save_cost_snapshot(self.session.user_id, self.session.conversation_id, snapshot)
        await self.send("session.cost", cost=snapshot)

    async def accept(self) -> None:
        await self.websocket.accept()
        await self.send(
            "session.ready",
            protocolVersion="1.0",
            capabilities={
                "audioInput": "pcm16-json-chunks",
                "asr": "qwen-realtime-asr" if self.realtime else "browser-fallback-through-gateway",
                "llm": "direct-multimodal-frame-answer-stream-or-mock",
                "tts": "qwen-omni-realtime-audio-stream" if self.realtime else "browser-speech-synthesis",
                "vision": "keyframe-buffer-realtime-window" if self.realtime else "keyframe-buffer-direct-answer-no-summary",
                "realtime": bool(self.realtime),
                "pipeline": pipecat_runtime_status(),
                "agents": ["medication_instruction"],
            },
        )
        await self.send_cost()

    async def run(self) -> None:
        await self.accept()
        try:
            while True:
                message = await self.websocket.receive_json()
                await self.handle(message)
        except WebSocketDisconnect:
            await self.cancel_generation(silent=True)
        finally:
            self.record_pending_stt_usage()
            if self.realtime:
                await self.realtime.close()

    async def handle(self, message: dict[str, Any]) -> None:
        message_type = message.get("type")
        if message_type == "session.start":
            await self.send("session.started")
        elif message_type == "audio.input.chunk":
            await self.handle_audio_chunk(message)
        elif message_type == "browser.asr.partial":
            text = str(message.get("text", "")).strip()
            if text:
                await self.send("asr.partial", text=text)
        elif message_type == "browser.asr.final":
            text = str(message.get("text", "")).strip()
            if text:
                await self.handle_final_transcript(text)
        elif message_type == "vision.frame":
            await self.handle_vision_frame(message)
        elif message_type == "vision.capture.failed":
            await self.handle_vision_capture_failed(message)
        elif message_type == "vision.clear":
            await self.handle_vision_clear(message)
        elif message_type == "speech.cancel":
            await self.cancel_generation()
            self.session.cost.interruptions += 1
            await self.send("speech.cancelled", reason=message.get("reason", "user_interrupt"))
            await self.send_cost()
        elif message_type == "session.voice.update":
            await self.handle_voice_update(message)
        else:
            await self.send("error", code="unknown_event", message=f"Unknown event: {message_type}")

    async def handle_audio_chunk(self, message: dict[str, Any]) -> None:
        duration_ms = int(message.get("durationMs", 0) or 0)
        rms = float(message.get("rms", 0.0) or 0.0)
        self.session.cost.record_audio_chunk(duration_ms, rms > 0.012)
        if self.realtime:
            audio = str(message.get("audio", ""))
            if audio:
                try:
                    await self.realtime.append_audio(audio)
                except Exception as exc:
                    await self.send("error", code="realtime_audio_failed", message=str(exc))
        if self.session.cost.audio_chunks % 25 == 0:
            self.record_pending_stt_usage()
            await self.send_cost()

    async def handle_vision_frame(self, message: dict[str, Any]) -> None:
        data_url = str(message.get("image", ""))
        reason = str(message.get("reason", "periodic"))
        request_id = str(message.get("requestId", ""))
        realtime_eligible = message.get("realtimeEligible", True) not in {False, "false", "False", "0", 0}
        if not data_url.startswith("data:image/"):
            await self.send("error", code="invalid_frame", message="vision.frame requires data:image URL")
            return

        image_hash = frame_hash(data_url)
        reused = bool(self.session.recent_frames and self.session.recent_frames[-1].frame_hash == image_hash)
        frame_snapshot = self.session.recent_frames[-1] if reused and self.session.recent_frames else None
        realtime_deferred = False
        if reused:
            self.session.cost.vision_cache_hits += 1
        else:
            frame_snapshot = FrameSnapshot(data_url=data_url, reason=reason, frame_hash=image_hash, captured_at=now_ms())
            self.session.recent_frames.append(frame_snapshot)
            cutoff = now_ms() - 10000
            self.session.recent_frames = [
                frame for frame in self.session.recent_frames if frame.captured_at >= cutoff
            ][-4:]
            if self.realtime and realtime_eligible:
                if not self.realtime.audio_append_seen:
                    realtime_deferred = True
                else:
                    try:
                        appended = await self.realtime.append_image(data_url)
                    except Exception:
                        appended = False
                    if appended:
                        self.session.cost.vision_frames += 1
                        self.record_vlm_frame_usage(reason)
                    else:
                        realtime_deferred = True
            elif self.realtime and not realtime_eligible:
                realtime_deferred = True

        if request_id and request_id in self.pending_capture_requests and frame_snapshot:
            future = self.pending_capture_requests[request_id]
            if not future.done():
                future.set_result(frame_snapshot)

        await self.send(
            "vision.frame.cached",
            reason=reason,
            frameHash=image_hash,
            reused=reused,
            bufferedFrames=len(self.session.recent_frames),
            realtimeDeferred=realtime_deferred,
        )
        await self.send_cost()

    async def handle_vision_capture_failed(self, message: dict[str, Any]) -> None:
        request_id = str(message.get("requestId", ""))
        if not request_id:
            return
        future = self.pending_capture_requests.get(request_id)
        if future and not future.done():
            future.set_result(None)

    async def request_agent_frame(
        self,
        agent: str,
        reason: str,
        instruction: str,
        realtime_eligible: bool,
        timeout_seconds: float,
    ) -> FrameSnapshot | None:
        request_id = str(uuid4())
        loop = asyncio.get_running_loop()
        future: asyncio.Future[FrameSnapshot | None] = loop.create_future()
        self.pending_capture_requests[request_id] = future
        await self.send(
            "vision.capture.request",
            requestId=request_id,
            agent=agent,
            reason=reason,
            quality="high",
            realtimeEligible=realtime_eligible,
            instruction=instruction,
        )
        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except asyncio.TimeoutError:
            return None
        finally:
            self.pending_capture_requests.pop(request_id, None)

    async def handle_vision_clear(self, message: dict[str, Any]) -> None:
        self.session.recent_frames.clear()
        await self.send(
            "vision.frames.cleared",
            reason=str(message.get("reason", "camera_state_changed")),
            bufferedFrames=0,
        )

    async def handle_voice_update(self, message: dict[str, Any]) -> None:
        voice = str(message.get("voice", "")).strip()
        if not voice:
            await self.send("error", code="invalid_voice", message="voice is required")
            return
        if not self.realtime:
            await self.send("voice.updated", voice=voice, provider="browser-fallback")
            return
        try:
            await self.realtime.update_session(voice)
        except Exception as exc:
            await self.send("error", code="voice_update_failed", message=str(exc))

    async def handle_final_transcript(self, text: str) -> None:
        await self.cancel_generation(silent=True)
        self.session.latest_transcript = text
        self.session.history.append({"role": "user", "content": text})
        append_message(self.session.user_id, self.session.conversation_id, "user", text)
        await self.send("asr.final", text=text)
        self.generation_task = asyncio.create_task(self.generate_response(text))

    async def cancel_generation(self, silent: bool = False) -> None:
        if self.realtime:
            await self.realtime.cancel()
        if self.generation_task and not self.generation_task.done():
            self.generation_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.generation_task
            if not silent:
                await self.send("llm.done", cancelled=True)
        self.generation_task = None

    async def send_provider_event(self, event_type: str, payload: Any) -> None:
        data = payload if isinstance(payload, dict) else {}
        await self.send(event_type, **data)
        if event_type == "response.audio.delta":
            self.record_realtime_tts_audio_usage(str(data.get("audio", "")), int(data.get("sampleRate", 24000) or 24000))
        if event_type == "llm.done" or event_type == "response.audio.done":
            await self.send_cost()

    async def record_realtime_user_transcript(self, text: str) -> None:
        self.session.latest_transcript = text
        self.session.history.append({"role": "user", "content": text})
        append_message(self.session.user_id, self.session.conversation_id, "user", text)
        await self.send("asr.final", text=text)
        active_medication_context = self.session.agent_state == "medication.ready_for_followup"
        if detect_medication_intent(text, active_context=active_medication_context).matched:
            if self.realtime:
                await self.realtime.cancel()
            await self.cancel_generation(silent=True)
            self.generation_task = asyncio.create_task(self.generate_response(text))

    async def record_realtime_assistant_transcript(self, text: str) -> None:
        clean = text.strip()
        if not clean:
            return
        self.session.history.append({"role": "assistant", "content": clean})
        append_message(self.session.user_id, self.session.conversation_id, "assistant", clean)

    async def generate_response(self, user_text: str) -> None:
        answer_parts: list[str] = []
        try:
            async for pipeline_event in self.pipeline.run_user_turn(user_text):
                if pipeline_event.type == "llm.delta":
                    answer_parts.append(str(pipeline_event.payload.get("delta", "")))
                if pipeline_event.type == "tts.audio.chunk":
                    self.record_tts_text_usage(str(pipeline_event.payload.get("text", "")), "browser-speech")
                await self.send(pipeline_event.type, **pipeline_event.payload)
            answer = "".join(answer_parts).strip()
            if answer:
                append_message(self.session.user_id, self.session.conversation_id, "assistant", answer)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self.send("error", code="generation_failed", message=str(exc))
            await self.send("llm.done", cancelled=True)

    def usage_provider(self) -> str:
        if self.realtime:
            return "qwen-realtime"
        return "direct-chat-completions"

    def usage_model(self) -> str:
        if self.realtime:
            return str(self.session.model_config.realtime_model) if self.session.model_config else "qwen-omni-realtime"
        return str(self.session.model_config.chat_model) if self.session.model_config else "direct-model"

    def record_pending_stt_usage(self) -> None:
        usage = self.session.cost.consume_pending_audio_usage()
        if usage["audio_ms"] <= 0 and usage["audio_chunks"] <= 0:
            return
        enqueue_usage_event(
            self.session.user_id,
            self.session.conversation_id,
            provider="browser-capture",
            model="microphone-stream",
            modality="stt",
            metric_type="audio_duration",
            audio_ms=usage["audio_ms"],
            speech_ms=usage["speech_ms"],
            audio_chunks=usage["audio_chunks"],
        )

    def record_tts_text_usage(self, text: str, provider: str) -> None:
        chars = len(text.strip())
        if chars <= 0:
            return
        enqueue_usage_event(
            self.session.user_id,
            self.session.conversation_id,
            provider=provider,
            model="browser-speech-synthesis",
            modality="tts",
            metric_type="text_characters",
            tts_chars=chars,
        )

    def record_realtime_tts_audio_usage(self, audio_base64: str, sample_rate: int) -> None:
        if not audio_base64 or sample_rate <= 0:
            return
        try:
            pcm_bytes = base64.b64decode(audio_base64, validate=False)
        except Exception:
            return
        audio_ms = int(len(pcm_bytes) / 2 / sample_rate * 1000)
        if audio_ms <= 0:
            return
        self.session.cost.tts_audio_ms += audio_ms
        enqueue_usage_event(
            self.session.user_id,
            self.session.conversation_id,
            provider=self.usage_provider(),
            model=self.usage_model(),
            modality="tts",
            metric_type="audio_duration",
            tts_audio_ms=audio_ms,
        )

    def record_vlm_frame_usage(self, reason: str) -> None:
        enqueue_usage_event(
            self.session.user_id,
            self.session.conversation_id,
            provider=self.usage_provider(),
            model=self.usage_model(),
            modality="vlm",
            metric_type="image_input",
            image_count=1,
            details={"reason": reason},
        )
