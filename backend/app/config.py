from dataclasses import dataclass
from os import getenv
from pathlib import Path

from dotenv import load_dotenv


load_dotenv()


DEFAULT_DATABASE_PATH = str(Path(__file__).resolve().parents[1] / "data" / "app.db")


def env_bool(name: str, default: bool = False) -> bool:
    value = getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    database_path: str = getenv("DATABASE_PATH") or DEFAULT_DATABASE_PATH
    jwt_secret_key: str = getenv("JWT_SECRET_KEY", "dev-only-change-me")
    jwt_algorithm: str = getenv("JWT_ALGORITHM", "HS256")
    access_token_minutes: int = int(getenv("ACCESS_TOKEN_MINUTES", "10080"))
    omni_api_key: str = getenv("OMNI_API_KEY", "") or getenv("DASHSCOPE_API_KEY", "")
    omni_base_url: str = getenv(
        "OMNI_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"
    ).rstrip("/")
    omni_model: str = getenv("OMNI_MODEL", "qwen3.5-omni-plus")
    omni_chat_model: str = getenv("OMNI_CHAT_MODEL", "")
    omni_realtime_enabled: bool = env_bool("OMNI_REALTIME_ENABLED", False)
    omni_realtime_base_url: str = getenv(
        "OMNI_REALTIME_BASE_URL", "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
    ).rstrip("/")
    omni_realtime_model: str = getenv("OMNI_REALTIME_MODEL", "qwen3-omni-flash-realtime")
    omni_realtime_voice: str = getenv("OMNI_REALTIME_VOICE", "Cherry")
    omni_realtime_vad_silence_ms: int = int(getenv("OMNI_REALTIME_VAD_SILENCE_MS", "1600"))
    vision_api_key: str = getenv("VISION_API_KEY", "")
    vision_base_url: str = getenv(
        "VISION_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"
    ).rstrip("/")
    vision_model: str = getenv("VISION_MODEL", "qwen-vl-plus")
    mock_latency_ms: int = int(getenv("MOCK_LATENCY_MS", "45"))

    @property
    def resolved_omni_chat_model(self) -> str:
        configured = self.omni_model.strip() or "qwen3.5-omni-plus"
        if configured.endswith("-realtime"):
            return self.omni_chat_model.strip() or "qwen3.5-omni-plus"
        return configured


settings = Settings()
