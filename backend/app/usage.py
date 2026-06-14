from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query

from .auth import current_user
from .db import list_usage_stats


router = APIRouter(prefix="/api/usage", tags=["usage"])


def usage_totals(row: dict[str, Any]) -> dict[str, Any]:
    prompt_tokens = int(row.get("prompt_tokens") or 0)
    completion_tokens = int(row.get("completion_tokens") or 0)
    return {
        "eventCount": int(row.get("event_count") or 0),
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "totalTokens": int(row.get("total_tokens") or prompt_tokens + completion_tokens),
        "estimatedPromptTokens": int(row.get("estimated_prompt_tokens") or 0),
        "estimatedCompletionTokens": int(row.get("estimated_completion_tokens") or 0),
        "audioMs": int(row.get("audio_ms") or 0),
        "speechMs": int(row.get("speech_ms") or 0),
        "audioChunks": int(row.get("audio_chunks") or 0),
        "ttsChars": int(row.get("tts_chars") or 0),
        "ttsAudioMs": int(row.get("tts_audio_ms") or 0),
        "imageCount": int(row.get("image_count") or 0),
        "estimatedUnits": float(row.get("estimated_units") or 0),
    }


def usage_bucket(row: dict[str, Any]) -> dict[str, Any]:
    bucket = usage_totals(row)
    if "id" in row:
        bucket["id"] = str(row["id"])
    if "title" in row:
        bucket["title"] = str(row["title"])
    if "modality" in row:
        bucket["modality"] = str(row["modality"])
    if "last_used_at" in row:
        bucket["lastUsedAt"] = int(row.get("last_used_at") or 0)
    return bucket


def recent_event(row: dict[str, Any]) -> dict[str, Any]:
    payload = usage_totals(row)
    payload.update(
        {
            "provider": str(row.get("provider") or ""),
            "model": str(row.get("model") or ""),
            "modality": str(row.get("modality") or ""),
            "metricType": str(row.get("metric_type") or ""),
            "createdAt": int(row.get("created_at") or 0),
        }
    )
    return payload


@router.get("/stats")
async def usage_stats(
    days: int = Query(default=7, ge=1, le=90),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    stats = list_usage_stats(str(user["id"]), days)
    return {
        "periodStart": int(stats["period_start"]),
        "periodEnd": int(stats["period_end"]),
        "generatedAt": int(stats["generated_at"]),
        "days": int(stats["days"]),
        "totals": usage_totals(dict(stats["totals"])),
        "modalities": [usage_bucket(dict(row)) for row in stats["modalities"]],
        "conversations": [usage_bucket(dict(row)) for row in stats["conversations"]],
        "recentEvents": [recent_event(dict(row)) for row in stats["recent_events"]],
    }
