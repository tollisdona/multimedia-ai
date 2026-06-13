from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import re
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .config import settings
from .models import SessionState


SENTENCE_RE = re.compile(r"(.+?[。！？!?；;])")


def estimate_tokens(text: str) -> int:
    return max(1, int(len(text) / 1.6))


def frame_hash(data_url: str) -> str:
    compact = data_url[-4096:].encode("utf-8", errors="ignore")
    return hashlib.sha256(compact).hexdigest()[:16]


def strip_data_url(data_url: str) -> str:
    if "," in data_url:
        return data_url.split(",", 1)[1]
    return data_url


def direct_model_system_prompt() -> str:
    return (
        "你是一个实时视频通话中的 AI 视觉对话助手。"
        "你会直接观察用户摄像头关键帧，并结合最近对话自然回答。"
        "优先根据图像证据回答，不要依赖外部视觉摘要；如果看不清、画面裁切、反光或信息不足，要明确说明不确定。"
        "回答要简洁、口语化，适合直接朗读。"
    )


def build_direct_messages(session: SessionState, user_text: str) -> list[dict[str, Any]]:
    recent = session.history[-8:]
    if not session.recent_frames:
        return [
            {"role": "system", "content": direct_model_system_prompt()},
            *recent,
            {"role": "user", "content": user_text},
        ]

    latest_frame = session.recent_frames[-1]
    visual_instruction = (
        "请直接观察这张最新摄像头关键帧来回答用户问题。"
        f"关键帧触发原因：{latest_frame.reason}。"
        "不要先生成摘要再回答；如果图中没有足够证据，请说明。"
    )
    return [
        {"role": "system", "content": direct_model_system_prompt()},
        *recent,
        {
            "role": "user",
            "content": [
                {"type": "text", "text": f"{visual_instruction}\n用户问题：{user_text}"},
                {"type": "image_url", "image_url": {"url": latest_frame.data_url, "detail": "auto"}},
            ],
        },
    ]


def direct_model_config() -> tuple[str, str, str, bool] | None:
    if settings.omni_api_key:
        return (
            settings.omni_api_key,
            settings.omni_base_url,
            settings.resolved_omni_chat_model,
            True,
        )
    if settings.vision_api_key:
        return (
            settings.vision_api_key,
            settings.vision_base_url,
            settings.vision_model,
            False,
        )
    return None


async def stream_direct_model(session: SessionState, user_text: str) -> AsyncIterator[str]:
    messages = build_direct_messages(session, user_text)
    text_for_estimate = "\n".join(
        item["content"] if isinstance(item.get("content"), str) else json.dumps(item.get("content"), ensure_ascii=False)
        for item in messages
    )
    session.cost.llm_input_tokens_est += estimate_tokens(text_for_estimate)

    model_config = direct_model_config()
    if model_config is None:
        text = (
            "我收到了你的问题。"
            f"你刚才说的是：{user_text}。"
            "当前没有配置 OMNI_API_KEY 或 VISION_API_KEY，所以这是本地 mock 回复。"
            "配置后我会把最新关键帧和问题直接发给多模态模型回答，不再走视觉摘要加文本模型。"
        )
        for i in range(0, len(text), 8):
            await asyncio.sleep(settings.mock_latency_ms / 1000)
            yield text[i : i + 8]
        return

    api_key, base_url, model, supports_modalities = model_config
    if session.recent_frames:
        session.cost.vision_frames += 1

    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "temperature": 0.35,
    }
    if supports_modalities:
        payload["modalities"] = ["text"]
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST", f"{base_url}/chat/completions", headers=headers, json=payload
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                raw = line.removeprefix("data: ").strip()
                if raw == "[DONE]":
                    break
                try:
                    choice = json.loads(raw)["choices"][0]
                    delta = choice.get("delta", {}).get("content", "")
                except (KeyError, json.JSONDecodeError, IndexError, TypeError):
                    continue
                if isinstance(delta, str) and delta:
                    yield delta


def sentence_chunks(buffer: str) -> tuple[list[str], str]:
    chunks: list[str] = []
    start = 0
    for match in SENTENCE_RE.finditer(buffer):
        chunk = match.group(0).strip()
        if len(chunk) >= 6:
            chunks.append(chunk)
            start = match.end()
    rest = buffer[start:]
    while len(rest) >= 42:
        split_at = max(rest.rfind("，", 0, 42), rest.rfind(",", 0, 42))
        if split_at < 12:
            split_at = 42
        chunks.append(rest[: split_at + 1].strip())
        rest = rest[split_at + 1 :]
    return chunks, rest


def validate_audio_payload(payload: str) -> bool:
    try:
        base64.b64decode(strip_data_url(payload), validate=False)
        return True
    except Exception:
        return False
