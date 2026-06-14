from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from .auth import current_user
from .config import settings
from .db import get_saved_model_config, save_model_config


router = APIRouter(prefix="/api/model-config", tags=["model-config"])


@dataclass(frozen=True)
class RuntimeModelConfig:
    api_key: str
    base_url: str
    chat_model: str
    supports_modalities: bool
    realtime_enabled: bool
    realtime_base_url: str
    realtime_model: str
    realtime_voice: str
    realtime_vad_silence_ms: int


class ModelConfigUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    apiKey: Optional[str] = Field(default=None, max_length=4096)
    clearApiKey: bool = False
    baseUrl: str = Field(min_length=1, max_length=500)
    chatModel: str = Field(min_length=1, max_length=120)
    realtimeEnabled: bool = False
    realtimeBaseUrl: str = Field(min_length=1, max_length=500)
    realtimeModel: str = Field(min_length=1, max_length=120)
    realtimeVoice: str = Field(min_length=1, max_length=60)


class ModelConfigOut(BaseModel):
    baseUrl: str
    chatModel: str
    realtimeEnabled: bool
    realtimeBaseUrl: str
    realtimeModel: str
    realtimeVoice: str
    keyConfigured: bool
    keyPreview: str
    keySource: str
    updatedAt: Optional[int] = None


def default_model_config_values() -> dict[str, Any]:
    return {
        "base_url": settings.omni_base_url,
        "chat_model": settings.resolved_omni_chat_model,
        "realtime_enabled": settings.omni_realtime_enabled,
        "realtime_base_url": settings.omni_realtime_base_url,
        "realtime_model": settings.omni_realtime_model,
        "realtime_voice": settings.omni_realtime_voice,
    }


def env_model_config() -> RuntimeModelConfig | None:
    if settings.omni_api_key:
        return RuntimeModelConfig(
            api_key=settings.omni_api_key,
            base_url=settings.omni_base_url,
            chat_model=settings.resolved_omni_chat_model,
            supports_modalities=True,
            realtime_enabled=settings.omni_realtime_enabled,
            realtime_base_url=settings.omni_realtime_base_url,
            realtime_model=settings.omni_realtime_model,
            realtime_voice=settings.omni_realtime_voice,
            realtime_vad_silence_ms=settings.omni_realtime_vad_silence_ms,
        )
    if settings.vision_api_key:
        return RuntimeModelConfig(
            api_key=settings.vision_api_key,
            base_url=settings.vision_base_url,
            chat_model=settings.vision_model,
            supports_modalities=False,
            realtime_enabled=False,
            realtime_base_url=settings.omni_realtime_base_url,
            realtime_model=settings.omni_realtime_model,
            realtime_voice=settings.omni_realtime_voice,
            realtime_vad_silence_ms=settings.omni_realtime_vad_silence_ms,
        )
    return None


def runtime_model_config_for_user(user_id: str) -> RuntimeModelConfig | None:
    saved = get_saved_model_config(user_id)
    if saved and saved.get("api_key"):
        return RuntimeModelConfig(
            api_key=str(saved["api_key"]),
            base_url=str(saved["base_url"]).rstrip("/"),
            chat_model=str(saved["chat_model"]),
            supports_modalities=True,
            realtime_enabled=bool(saved["realtime_enabled"]),
            realtime_base_url=str(saved["realtime_base_url"]).rstrip("/"),
            realtime_model=str(saved["realtime_model"]),
            realtime_voice=str(saved["realtime_voice"]),
            realtime_vad_silence_ms=settings.omni_realtime_vad_silence_ms,
        )
    return env_model_config()


def public_model_config(user_id: str) -> ModelConfigOut:
    defaults = default_model_config_values()
    saved = get_saved_model_config(user_id)
    env_config = env_model_config()
    if saved:
        values = {**defaults, **saved}
        api_key = str(saved.get("api_key") or "")
        key_source = "user" if api_key else ("environment" if env_config else "missing")
        key_preview = f"...{api_key[-4:]}" if api_key else ("环境变量已配置" if env_config else "")
        updated_at = int(saved["updated_at"])
    else:
        values = defaults
        key_source = "environment" if env_config else "missing"
        key_preview = "环境变量已配置" if env_config else ""
        updated_at = None
    return ModelConfigOut(
        baseUrl=str(values["base_url"]),
        chatModel=str(values["chat_model"]),
        realtimeEnabled=bool(values["realtime_enabled"]),
        realtimeBaseUrl=str(values["realtime_base_url"]),
        realtimeModel=str(values["realtime_model"]),
        realtimeVoice=str(values["realtime_voice"]),
        keyConfigured=key_source != "missing",
        keyPreview=key_preview,
        keySource=key_source,
        updatedAt=updated_at,
    )


@router.get("", response_model=ModelConfigOut)
async def get_model_config(user: dict[str, Any] = Depends(current_user)) -> ModelConfigOut:
    return public_model_config(str(user["id"]))


@router.put("", response_model=ModelConfigOut)
async def update_model_config(
    payload: ModelConfigUpdate,
    user: dict[str, Any] = Depends(current_user),
) -> ModelConfigOut:
    save_model_config(str(user["id"]), payload.model_dump())
    return public_model_config(str(user["id"]))
