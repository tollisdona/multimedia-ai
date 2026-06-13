from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Any

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from .ai import frame_hash
from .conversation_pipeline import ConversationPipeline, pipecat_runtime_status
from .db import append_message, save_cost_snapshot
from .models import FrameSnapshot, SessionState, event, now_ms


class GatewayConnection:
    def __init__(self, websocket: WebSocket, user_id: str, conversation_id: str) -> None:
        self.websocket = websocket
        self.session = SessionState(user_id=user_id, conversation_id=conversation_id)
        self.pipeline = ConversationPipeline(self.session)
        self.generation_task: asyncio.Task[None] | None = None
        self.send_lock = asyncio.Lock()

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
                "asr": "browser-fallback-through-gateway",
                "llm": "direct-multimodal-frame-answer-stream-or-mock",
                "tts": "browser-speech-synthesis",
                "vision": "keyframe-buffer-direct-answer-no-summary",
                "pipeline": pipecat_runtime_status(),
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
        elif message_type == "speech.cancel":
            await self.cancel_generation()
            self.session.cost.interruptions += 1
            await self.send("speech.cancelled", reason=message.get("reason", "user_interrupt"))
            await self.send_cost()
        else:
            await self.send("error", code="unknown_event", message=f"Unknown event: {message_type}")

    async def handle_audio_chunk(self, message: dict[str, Any]) -> None:
        duration_ms = int(message.get("durationMs", 0) or 0)
        rms = float(message.get("rms", 0.0) or 0.0)
        self.session.cost.audio_chunks += 1
        self.session.cost.audio_ms += max(0, min(duration_ms, 200))
        if rms > 0.012:
            self.session.cost.speech_ms += max(0, min(duration_ms, 200))
        if self.session.cost.audio_chunks % 25 == 0:
            await self.send_cost()

    async def handle_vision_frame(self, message: dict[str, Any]) -> None:
        data_url = str(message.get("image", ""))
        reason = str(message.get("reason", "periodic"))
        if not data_url.startswith("data:image/"):
            await self.send("error", code="invalid_frame", message="vision.frame requires data:image URL")
            return

        image_hash = frame_hash(data_url)
        reused = bool(self.session.recent_frames and self.session.recent_frames[-1].frame_hash == image_hash)
        if reused:
            self.session.cost.vision_cache_hits += 1
        else:
            self.session.recent_frames.append(
                FrameSnapshot(data_url=data_url, reason=reason, frame_hash=image_hash, captured_at=now_ms())
            )
            self.session.recent_frames = self.session.recent_frames[-4:]

        await self.send(
            "vision.frame.cached",
            reason=reason,
            frameHash=image_hash,
            reused=reused,
            bufferedFrames=len(self.session.recent_frames),
        )
        await self.send_cost()

    async def handle_final_transcript(self, text: str) -> None:
        await self.cancel_generation(silent=True)
        self.session.latest_transcript = text
        self.session.history.append({"role": "user", "content": text})
        append_message(self.session.user_id, self.session.conversation_id, "user", text)
        await self.send("asr.final", text=text)
        self.generation_task = asyncio.create_task(self.generate_response(text))

    async def cancel_generation(self, silent: bool = False) -> None:
        if self.generation_task and not self.generation_task.done():
            self.generation_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.generation_task
            if not silent:
                await self.send("llm.done", cancelled=True)
        self.generation_task = None

    async def generate_response(self, user_text: str) -> None:
        answer_parts: list[str] = []
        try:
            async for pipeline_event in self.pipeline.run_user_turn(user_text):
                if pipeline_event.type == "llm.delta":
                    answer_parts.append(str(pipeline_event.payload.get("delta", "")))
                await self.send(pipeline_event.type, **pipeline_event.payload)
            answer = "".join(answer_parts).strip()
            if answer:
                append_message(self.session.user_id, self.session.conversation_id, "assistant", answer)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self.send("error", code="generation_failed", message=str(exc))
            await self.send("llm.done", cancelled=True)
