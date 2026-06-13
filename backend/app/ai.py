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
from .models import SessionState, VisionSummary, now_ms


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


async def analyze_vision(data_url: str, reason: str, previous_hash: str = "") -> VisionSummary:
    image_hash = frame_hash(data_url)
    if image_hash == previous_hash:
        return VisionSummary(
            summary="画面与上一关键帧高度相似，复用上一轮视觉摘要以节省成本。",
            frame_hash=image_hash,
            updated_at=now_ms(),
            source="cache",
            confidence=0.92,
        )

    if not settings.vision_api_key:
        await asyncio.sleep(settings.mock_latency_ms / 1000)
        return VisionSummary(
            summary=(
                "已收到一帧摄像头画面。当前为低成本 mock 视觉模式："
                f"触发原因是 {reason}。配置 VISION_API_KEY 后会调用真实视觉模型识别场景、物体和文字。"
            ),
            objects=["camera-frame", "mock-vision"],
            text_seen="",
            confidence=0.68,
            frame_hash=image_hash,
            updated_at=now_ms(),
            source="mock",
        )

    payload = {
        "model": settings.vision_model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是视频对话助手的视觉理解模块。请用中文输出简洁可靠的结构化观察，"
                    "避免编造看不清的细节。"
                ),
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "请分析这一帧摄像头画面，返回 JSON："
                            "{\"summary\":\"...\",\"objects\":[\"...\"],\"text_seen\":\"...\",\"confidence\":0.0}"
                        ),
                    },
                    {"type": "image_url", "image_url": {"url": data_url, "detail": "low"}},
                ],
            },
        ],
        "temperature": 0.2,
    }
    headers = {
        "Authorization": f"Bearer {settings.vision_api_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"{settings.vision_base_url}/chat/completions", headers=headers, json=payload
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        parsed = {"summary": content, "objects": [], "text_seen": "", "confidence": 0.75}

    return VisionSummary(
        summary=str(parsed.get("summary", content)),
        objects=list(parsed.get("objects", []))[:8],
        text_seen=str(parsed.get("text_seen", "")),
        confidence=float(parsed.get("confidence", 0.75)),
        frame_hash=image_hash,
        updated_at=now_ms(),
        source=settings.vision_model,
    )


def system_prompt() -> str:
    return (
        "你是一个 AI 视觉对话助手。你会结合用户语音转写和最新视觉摘要回答。"
        "回答要自然、简洁、口语化；如果视觉摘要置信度低，要说明只能基于关键帧判断。"
        "不要声称自己正在持续观看完整视频流，只能说你基于最近关键帧和对话上下文判断。"
    )


def build_messages(session: SessionState, user_text: str) -> list[dict[str, str]]:
    vision = session.latest_vision
    context = (
        f"最新视觉摘要：{vision.summary}\n"
        f"可见物体：{', '.join(vision.objects) if vision.objects else '未知'}\n"
        f"画面文字：{vision.text_seen or '未识别到'}\n"
        f"视觉来源：{vision.source}，置信度：{vision.confidence}\n"
    )
    recent = session.history[-8:]
    return [
        {"role": "system", "content": system_prompt()},
        {"role": "system", "content": context},
        *recent,
        {"role": "user", "content": user_text},
    ]


async def stream_llm(session: SessionState, user_text: str) -> AsyncIterator[str]:
    messages = build_messages(session, user_text)
    session.cost.llm_input_tokens_est += estimate_tokens("\n".join(m["content"] for m in messages))

    if not settings.llm_api_key:
        text = (
            "我收到了你的问题。"
            f"你刚才说的是：{user_text}。"
            f"根据最近关键帧，{session.latest_vision.summary}"
            "我会优先复用视觉摘要，只有在画面变化或你明确问到视觉细节时才重新分析图片，这样可以降低运行成本。"
        )
        for i in range(0, len(text), 8):
            await asyncio.sleep(settings.mock_latency_ms / 1000)
            yield text[i : i + 8]
        return

    payload = {
        "model": settings.llm_model,
        "messages": messages,
        "stream": True,
        "temperature": 0.6,
    }
    headers = {
        "Authorization": f"Bearer {settings.llm_api_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST", f"{settings.llm_base_url}/chat/completions", headers=headers, json=payload
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                raw = line.removeprefix("data: ").strip()
                if raw == "[DONE]":
                    break
                try:
                    delta = json.loads(raw)["choices"][0]["delta"].get("content", "")
                except (KeyError, json.JSONDecodeError, IndexError):
                    continue
                if delta:
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
