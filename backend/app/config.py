from dataclasses import dataclass
from os import getenv
from pathlib import Path

from dotenv import load_dotenv


load_dotenv()


DEFAULT_DATABASE_PATH = str(Path(__file__).resolve().parents[1] / "data" / "app.db")


@dataclass(frozen=True)
class Settings:
    database_path: str = getenv("DATABASE_PATH") or DEFAULT_DATABASE_PATH
    jwt_secret_key: str = getenv("JWT_SECRET_KEY", "dev-only-change-me")
    jwt_algorithm: str = getenv("JWT_ALGORITHM", "HS256")
    access_token_minutes: int = int(getenv("ACCESS_TOKEN_MINUTES", "10080"))
    llm_api_key: str = getenv("LLM_API_KEY", "")
    llm_base_url: str = getenv("LLM_BASE_URL", "https://api.deepseek.com").rstrip("/")
    llm_model: str = getenv("LLM_MODEL", "deepseek-chat")
    vision_api_key: str = getenv("VISION_API_KEY", "")
    vision_base_url: str = getenv(
        "VISION_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"
    ).rstrip("/")
    vision_model: str = getenv("VISION_MODEL", "qwen-vl-plus")
    mock_latency_ms: int = int(getenv("MOCK_LATENCY_MS", "45"))


settings = Settings()
