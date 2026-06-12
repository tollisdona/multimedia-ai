from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Any

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from .ai import analyze_vision, estimate_tokens, sentence_chunks, stream_llm
from .models import SessionState, event


class GatewayConnection:
    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self.session = SessionState()
        self.generation_task: asyncio.Task[None] | None = None
        self.send_lock = asyncio.Lock()

    async def send(self, event_type: str, **payload: Any) -> None:
        async with self.send_lock:
            await self.websocket.send_json(event(event_type, sessionId=self.session.session_id, **payload))

    async def send_cost(self) -> None:
        await self.send("session.cost", cost=self.session.cost.snapshot())

    async def accept(self) -> None:
        await self.websocket.accept()
        await self.send(
            "session.ready",
            protocolVersion="1.0",
            capabilities={
                "audioInput": "pcm16-json-chunks",
                "asr": "browser-fallback-through-gateway",
                "llm": "openai-compatible-stream-or-mock",
                "tts": "browser-speech-synthesis",
                "vision": "keyframe-vl-or-mock",
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

        previous_hash = self.session.latest_vision.frame_hash
        summary = await analyze_vision(data_url, reason, previous_hash)
        if summary.source == "cache":
            self.session.cost.vision_cache_hits += 1
            summary.summary = self.session.latest_vision.summary
            summary.objects = self.session.latest_vision.objects
            summary.text_seen = self.session.latest_vision.text_seen
            summary.confidence = max(summary.confidence, self.session.latest_vision.confidence)
        else:
            self.session.cost.vision_frames += 1
        self.session.latest_vision = summary
        await self.send(
            "vision.summary",
            summary=summary.summary,
            objects=summary.objects,
            textSeen=summary.text_seen,
            confidence=summary.confidence,
            source=summary.source,
            reason=reason,
        )
        await self.send_cost()

    async def handle_final_transcript(self, text: str) -> None:
        await self.cancel_generation(silent=True)
        self.session.latest_transcript = text
        self.session.history.append({"role": "user", "content": text})
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
        answer = ""
        tts_buffer = ""
        try:
            async for delta in stream_llm(self.session, user_text):
                answer += delta
                tts_buffer += delta
                self.session.cost.llm_output_tokens_est += estimate_tokens(delta)
                await self.send("llm.delta", delta=delta)

                chunks, tts_buffer = sentence_chunks(tts_buffer)
                for chunk in chunks:
                    self.session.cost.tts_chars += len(chunk)
                    await self.send("tts.audio.chunk", mode="browser-speech", text=chunk)
                    await self.send_cost()

            tail = tts_buffer.strip()
            if tail:
                self.session.cost.tts_chars += len(tail)
                await self.send("tts.audio.chunk", mode="browser-speech", text=tail)

            if answer.strip():
                self.session.history.append({"role": "assistant", "content": answer.strip()})
            await self.send("llm.done", cancelled=False)
            await self.send_cost()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self.send("error", code="generation_failed", message=str(exc))
            await self.send("llm.done", cancelled=True)
