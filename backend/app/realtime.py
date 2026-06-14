from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from contextlib import suppress
from typing import Any
from uuid import uuid4

import websockets
from websockets.client import WebSocketClientProtocol

from .ai import direct_model_system_prompt, estimate_tokens, strip_data_url
from .model_config import RuntimeModelConfig, env_model_config
from .models import SessionState


Emit = Callable[[str, Any], Awaitable[None]]
TranscriptHook = Callable[[str], Awaitable[None]]


def realtime_available(model_config: RuntimeModelConfig | None = None) -> bool:
    configured = model_config or env_model_config()
    return bool(configured and configured.realtime_enabled and configured.api_key)


def realtime_url(model_config: RuntimeModelConfig) -> str:
    separator = "&" if "?" in model_config.realtime_base_url else "?"
    return f"{model_config.realtime_base_url}{separator}model={model_config.realtime_model}"


class QwenRealtimeProvider:
    def __init__(
        self,
        session: SessionState,
        emit: Emit,
        on_user_transcript: TranscriptHook,
        on_assistant_transcript: TranscriptHook,
        model_config: RuntimeModelConfig,
    ) -> None:
        self.session = session
        self.emit = emit
        self.on_user_transcript = on_user_transcript
        self.on_assistant_transcript = on_assistant_transcript
        self.model_config = model_config
        self.voice = model_config.realtime_voice
        self.websocket: WebSocketClientProtocol | None = None
        self.receive_task: asyncio.Task[None] | None = None
        self.send_lock = asyncio.Lock()
        self.assistant_buffer = ""
        self.assistant_saved = False
        self.connected = False

    async def connect(self) -> None:
        if self.websocket and self.connected:
            return
        headers = {"Authorization": f"Bearer {self.model_config.api_key}"}
        self.websocket = await websockets.connect(realtime_url(self.model_config), extra_headers=headers, max_size=None)
        self.connected = True
        self.receive_task = asyncio.create_task(self.receive_loop())
        await self.update_session(self.voice)

    async def close(self) -> None:
        self.connected = False
        if self.receive_task:
            self.receive_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.receive_task
        self.receive_task = None
        if self.websocket:
            await self.websocket.close()
        self.websocket = None

    async def update_session(self, voice: str | None = None) -> None:
        if voice:
            self.voice = voice
        await self.send_raw(
            {
                "event_id": self.event_id(),
                "type": "session.update",
                "session": {
                    "modalities": ["text", "audio"],
                    "voice": self.voice,
                    "input_audio_format": "pcm",
                    "output_audio_format": "pcm",
                    "input_audio_transcription": {"model": "qwen3-asr-flash-realtime"},
                    "smooth_output": True,
                    "instructions": direct_model_system_prompt(),
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": 0.35,
                        "silence_duration_ms": self.model_config.realtime_vad_silence_ms,
                    },
                },
            }
        )

    async def append_audio(self, audio_base64: str) -> None:
        await self.ensure_connected()
        await self.send_raw(
            {
                "event_id": self.event_id(),
                "type": "input_audio_buffer.append",
                "audio": audio_base64,
            }
        )

    async def append_image(self, data_url: str) -> None:
        await self.ensure_connected()
        await self.send_raw(
            {
                "event_id": self.event_id(),
                "type": "input_image_buffer.append",
                "image": strip_data_url(data_url),
            }
        )

    async def cancel(self) -> None:
        if not self.websocket or not self.connected:
            return
        with suppress(Exception):
            await self.send_raw({"event_id": self.event_id(), "type": "response.cancel"})
        with suppress(Exception):
            await self.send_raw({"event_id": self.event_id(), "type": "input_audio_buffer.clear"})

    async def ensure_connected(self) -> None:
        if not self.websocket or not self.connected:
            await self.connect()

    async def send_raw(self, payload: dict[str, Any]) -> None:
        await self.ensure_socket()
        async with self.send_lock:
            await self.websocket.send(json.dumps(payload, ensure_ascii=False))

    async def ensure_socket(self) -> None:
        if not self.websocket or not self.connected:
            await self.connect()

    async def receive_loop(self) -> None:
        assert self.websocket is not None
        try:
            async for raw in self.websocket:
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                await self.handle_server_event(payload)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.connected = False
            await self.emit("error", {"code": "realtime_disconnected", "message": str(exc)})

    async def handle_server_event(self, payload: dict[str, Any]) -> None:
        event_type = str(payload.get("type", ""))
        if event_type == "error":
            error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
            await self.emit(
                "error",
                {
                    "code": str(error.get("code", "realtime_error")),
                    "message": str(error.get("message", "Realtime provider error")),
                },
            )
            return

        if event_type == "session.updated":
            session = payload.get("session") if isinstance(payload.get("session"), dict) else {}
            voice = str(session.get("voice") or self.voice)
            self.voice = voice
            await self.emit("voice.updated", {"voice": voice, "provider": "qwen-omni-realtime"})
            return

        if event_type == "input_audio_buffer.speech_started":
            await self.emit("realtime.speech.started", {})
            return

        if event_type == "input_audio_buffer.speech_stopped":
            await self.emit("realtime.speech.stopped", {})
            return

        if event_type == "conversation.item.input_audio_transcription.delta":
            text = f"{payload.get('text', '')}{payload.get('stash', '')}".strip()
            if text:
                await self.emit("asr.partial", {"text": text})
            return

        if event_type == "conversation.item.input_audio_transcription.completed":
            transcript = str(payload.get("transcript", "")).strip()
            if transcript:
                await self.on_user_transcript(transcript)
            return

        if event_type in {"response.audio_transcript.delta", "response.text.delta"}:
            delta = str(payload.get("delta", ""))
            if delta:
                self.assistant_saved = False
                self.assistant_buffer += delta
                self.session.cost.llm_output_tokens_est += estimate_tokens(delta)
                await self.emit("response.text.delta", {"delta": delta})
            return

        if event_type == "response.audio_transcript.done":
            transcript = str(payload.get("transcript", "")).strip()
            if transcript:
                self.assistant_buffer = transcript
                await self.on_assistant_transcript(transcript)
                self.assistant_saved = True
                self.assistant_buffer = ""
            return

        if event_type == "response.audio.delta":
            delta = str(payload.get("delta", ""))
            if delta:
                await self.emit(
                    "response.audio.delta",
                    {"audio": delta, "encoding": "pcm16", "sampleRate": 24000},
                )
            return

        if event_type == "response.audio.done":
            await self.emit("response.audio.done", {})
            return

        if event_type == "response.done":
            if self.assistant_buffer.strip() and not self.assistant_saved:
                await self.on_assistant_transcript(self.assistant_buffer.strip())
            self.assistant_saved = False
            self.assistant_buffer = ""
            usage = payload.get("response", {}).get("usage", {}) if isinstance(payload.get("response"), dict) else {}
            if isinstance(usage, dict):
                self.session.cost.llm_input_tokens_est += int(usage.get("input_tokens", 0) or 0)
                self.session.cost.llm_output_tokens_est += int(usage.get("output_tokens", 0) or 0)
            await self.emit("llm.done", {"cancelled": False})
            return

    def event_id(self) -> str:
        return f"event_{uuid4().hex}"
