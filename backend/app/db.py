from __future__ import annotations

import base64
import hashlib
import sqlite3
import json
from pathlib import Path
from typing import Any
from uuid import uuid4

from cryptography.fernet import Fernet, InvalidToken

from .config import settings
from .models import now_ms


def connect() -> sqlite3.Connection:
    db_path = Path(settings.database_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db() -> None:
    with connect() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                title TEXT NOT NULL,
                latest_vision_json TEXT NOT NULL DEFAULT '{}',
                latest_cost_json TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                role TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(conversation_id) REFERENCES conversations(id),
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS cost_snapshots (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                snapshot_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(conversation_id) REFERENCES conversations(id),
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS user_model_configs (
                user_id TEXT PRIMARY KEY,
                api_key_ciphertext TEXT NOT NULL DEFAULT '',
                base_url TEXT NOT NULL,
                chat_model TEXT NOT NULL,
                realtime_enabled INTEGER NOT NULL DEFAULT 0,
                realtime_base_url TEXT NOT NULL,
                realtime_model TEXT NOT NULL,
                realtime_voice TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS usage_events (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                modality TEXT NOT NULL,
                metric_type TEXT NOT NULL,
                prompt_tokens INTEGER NOT NULL DEFAULT 0,
                completion_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                estimated_prompt_tokens INTEGER NOT NULL DEFAULT 0,
                estimated_completion_tokens INTEGER NOT NULL DEFAULT 0,
                audio_ms INTEGER NOT NULL DEFAULT 0,
                speech_ms INTEGER NOT NULL DEFAULT 0,
                audio_chunks INTEGER NOT NULL DEFAULT 0,
                tts_chars INTEGER NOT NULL DEFAULT 0,
                tts_audio_ms INTEGER NOT NULL DEFAULT 0,
                image_count INTEGER NOT NULL DEFAULT 0,
                event_json TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL,
                FOREIGN KEY(conversation_id) REFERENCES conversations(id),
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_conversations_user_updated
            ON conversations(user_id, updated_at DESC)
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
            ON messages(conversation_id, user_id, created_at ASC)
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_cost_snapshots_conversation_created
            ON cost_snapshots(conversation_id, user_id, created_at DESC)
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_usage_events_user_created
            ON usage_events(user_id, created_at DESC)
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_usage_events_conversation_created
            ON usage_events(conversation_id, user_id, created_at DESC)
            """
        )


def api_key_cipher() -> Fernet:
    digest = hashlib.sha256(settings.jwt_secret_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_api_key(api_key: str) -> str:
    clean = api_key.strip()
    if not clean:
        return ""
    return api_key_cipher().encrypt(clean.encode("utf-8")).decode("utf-8")


def decrypt_api_key(ciphertext: str) -> str:
    if not ciphertext:
        return ""
    try:
        return api_key_cipher().decrypt(ciphertext.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        return ""


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row else None


def create_user(username: str, password_hash: str) -> dict[str, Any]:
    user_id = str(uuid4())
    normalized = normalize_username(username)
    with connect() as connection:
        connection.execute(
            "INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
            (user_id, normalized, password_hash, now_ms()),
        )
        row = connection.execute(
            "SELECT id, username, created_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    user = row_to_dict(row)
    if not user:
        raise RuntimeError("failed to create user")
    return user


def get_user_by_username(username: str) -> dict[str, Any] | None:
    with connect() as connection:
        row = connection.execute(
            "SELECT id, username, password_hash, created_at FROM users WHERE username = ?",
            (normalize_username(username),),
        ).fetchone()
    return row_to_dict(row)


def get_user_by_id(user_id: str) -> dict[str, Any] | None:
    with connect() as connection:
        row = connection.execute(
            "SELECT id, username, created_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    return row_to_dict(row)


def default_saved_model_values() -> dict[str, Any]:
    return {
        "base_url": settings.omni_base_url,
        "chat_model": settings.resolved_omni_chat_model,
        "realtime_enabled": settings.omni_realtime_enabled,
        "realtime_base_url": settings.omni_realtime_base_url,
        "realtime_model": settings.omni_realtime_model,
        "realtime_voice": settings.omni_realtime_voice,
    }


def get_saved_model_config(user_id: str) -> dict[str, Any] | None:
    with connect() as connection:
        row = connection.execute(
            """
            SELECT user_id, api_key_ciphertext, base_url, chat_model, realtime_enabled,
                   realtime_base_url, realtime_model, realtime_voice, updated_at
            FROM user_model_configs
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()
    config = row_to_dict(row)
    if not config:
        return None
    config["api_key"] = decrypt_api_key(str(config.pop("api_key_ciphertext", "")))
    config["realtime_enabled"] = bool(config["realtime_enabled"])
    return config


def save_model_config(user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    current = get_saved_model_config(user_id)
    defaults = default_saved_model_values()
    previous_api_key = str(current.get("api_key", "")) if current else ""
    next_api_key = previous_api_key
    if payload.get("clearApiKey"):
        next_api_key = ""
    elif payload.get("apiKey"):
        next_api_key = str(payload["apiKey"]).strip()

    values = {
        "base_url": str(payload.get("baseUrl") or defaults["base_url"]).rstrip("/"),
        "chat_model": str(payload.get("chatModel") or defaults["chat_model"]),
        "realtime_enabled": 1 if payload.get("realtimeEnabled") else 0,
        "realtime_base_url": str(payload.get("realtimeBaseUrl") or defaults["realtime_base_url"]).rstrip("/"),
        "realtime_model": str(payload.get("realtimeModel") or defaults["realtime_model"]),
        "realtime_voice": str(payload.get("realtimeVoice") or defaults["realtime_voice"]),
        "api_key_ciphertext": encrypt_api_key(next_api_key),
        "updated_at": now_ms(),
    }
    with connect() as connection:
        connection.execute(
            """
            INSERT INTO user_model_configs
                (user_id, api_key_ciphertext, base_url, chat_model, realtime_enabled,
                 realtime_base_url, realtime_model, realtime_voice, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                api_key_ciphertext = excluded.api_key_ciphertext,
                base_url = excluded.base_url,
                chat_model = excluded.chat_model,
                realtime_enabled = excluded.realtime_enabled,
                realtime_base_url = excluded.realtime_base_url,
                realtime_model = excluded.realtime_model,
                realtime_voice = excluded.realtime_voice,
                updated_at = excluded.updated_at
            """,
            (
                user_id,
                values["api_key_ciphertext"],
                values["base_url"],
                values["chat_model"],
                values["realtime_enabled"],
                values["realtime_base_url"],
                values["realtime_model"],
                values["realtime_voice"],
                values["updated_at"],
            ),
        )
    saved = get_saved_model_config(user_id)
    if not saved:
        raise RuntimeError("failed to save model config")
    return saved


def normalize_username(username: str) -> str:
    return username.strip().lower()


def normalize_conversation_title(title: str) -> str:
    return title.strip()[:80] or "新会话"


def create_conversation(user_id: str, title: str = "新会话") -> dict[str, Any]:
    conversation_id = str(uuid4())
    now = now_ms()
    with connect() as connection:
        connection.execute(
            """
            INSERT INTO conversations
                (id, user_id, title, latest_vision_json, latest_cost_json, created_at, updated_at)
            VALUES (?, ?, ?, '{}', '{}', ?, ?)
            """,
            (conversation_id, user_id, normalize_conversation_title(title), now, now),
        )
        row = conversation_row(connection, user_id, conversation_id)
    conversation = row_to_dict(row)
    if not conversation:
        raise RuntimeError("failed to create conversation")
    return decorate_conversation(conversation)


def list_conversations(user_id: str) -> list[dict[str, Any]]:
    with connect() as connection:
        rows = connection.execute(
            """
            SELECT c.*, COUNT(m.id) AS message_count
            FROM conversations c
            LEFT JOIN messages m ON m.conversation_id = c.id
            WHERE c.user_id = ?
            GROUP BY c.id
            ORDER BY c.updated_at DESC
            """,
            (user_id,),
        ).fetchall()
    return [decorate_conversation(dict(row)) for row in rows]


def get_conversation(user_id: str, conversation_id: str) -> dict[str, Any] | None:
    with connect() as connection:
        row = conversation_row(connection, user_id, conversation_id)
    conversation = row_to_dict(row)
    return decorate_conversation(conversation) if conversation else None


def update_conversation_title(user_id: str, conversation_id: str, title: str) -> dict[str, Any] | None:
    now = now_ms()
    with connect() as connection:
        if not conversation_row(connection, user_id, conversation_id):
            return None
        connection.execute(
            "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?",
            (normalize_conversation_title(title), now, conversation_id, user_id),
        )
        row = conversation_row(connection, user_id, conversation_id)
    conversation = row_to_dict(row)
    return decorate_conversation(conversation) if conversation else None


def delete_conversation(user_id: str, conversation_id: str) -> bool:
    with connect() as connection:
        if not conversation_row(connection, user_id, conversation_id):
            return False
        connection.execute(
            "DELETE FROM cost_snapshots WHERE conversation_id = ? AND user_id = ?",
            (conversation_id, user_id),
        )
        connection.execute(
            "DELETE FROM usage_events WHERE conversation_id = ? AND user_id = ?",
            (conversation_id, user_id),
        )
        connection.execute(
            "DELETE FROM messages WHERE conversation_id = ? AND user_id = ?",
            (conversation_id, user_id),
        )
        cursor = connection.execute(
            "DELETE FROM conversations WHERE id = ? AND user_id = ?",
            (conversation_id, user_id),
        )
    return cursor.rowcount > 0


def conversation_row(connection: sqlite3.Connection, user_id: str, conversation_id: str) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT c.*, COUNT(m.id) AS message_count
        FROM conversations c
        LEFT JOIN messages m ON m.conversation_id = c.id
        WHERE c.user_id = ? AND c.id = ?
        GROUP BY c.id
        """,
        (user_id, conversation_id),
    ).fetchone()


def list_messages(user_id: str, conversation_id: str) -> list[dict[str, Any]]:
    with connect() as connection:
        rows = connection.execute(
            """
            SELECT m.id, m.role, m.text, m.created_at
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE m.conversation_id = ? AND c.user_id = ? AND m.user_id = ?
            ORDER BY m.created_at ASC
            """,
            (conversation_id, user_id, user_id),
        ).fetchall()
    return [dict(row) for row in rows]


def append_message(user_id: str, conversation_id: str, role: str, text: str) -> dict[str, Any]:
    message_id = str(uuid4())
    now = now_ms()
    clean = text.strip()
    with connect() as connection:
        connection.execute(
            "INSERT INTO messages (id, conversation_id, user_id, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (message_id, conversation_id, user_id, role, clean, now),
        )
        if role == "user":
            message_count = connection.execute(
                "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()["count"]
            title = clean[:28] or "新会话"
            if message_count <= 1:
                connection.execute(
                    "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                    (title, now, conversation_id, user_id),
                )
            else:
                touch_conversation(connection, user_id, conversation_id, now)
        else:
            touch_conversation(connection, user_id, conversation_id, now)
        row = connection.execute(
            "SELECT id, role, text, created_at FROM messages WHERE id = ?",
            (message_id,),
        ).fetchone()
    message = row_to_dict(row)
    if not message:
        raise RuntimeError("failed to append message")
    return message


def save_cost_snapshot(user_id: str, conversation_id: str, snapshot: dict[str, Any]) -> None:
    snapshot_json = json.dumps(snapshot, ensure_ascii=False)
    now = now_ms()
    with connect() as connection:
        connection.execute(
            "INSERT INTO cost_snapshots (id, conversation_id, user_id, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)",
            (str(uuid4()), conversation_id, user_id, snapshot_json, now),
        )
        connection.execute(
            "UPDATE conversations SET latest_cost_json = ?, updated_at = ? WHERE id = ? AND user_id = ?",
            (snapshot_json, now, conversation_id, user_id),
        )


def enqueue_usage_event(
    user_id: str,
    conversation_id: str,
    *,
    provider: str,
    model: str,
    modality: str,
    metric_type: str,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    estimated_prompt_tokens: int = 0,
    estimated_completion_tokens: int = 0,
    audio_ms: int = 0,
    speech_ms: int = 0,
    audio_chunks: int = 0,
    tts_chars: int = 0,
    tts_audio_ms: int = 0,
    image_count: int = 0,
    details: dict[str, Any] | None = None,
) -> None:
    event_payload = {
        "id": str(uuid4()),
        "conversation_id": conversation_id,
        "user_id": user_id,
        "provider": provider,
        "model": model,
        "modality": modality,
        "metric_type": metric_type,
        "prompt_tokens": max(0, int(prompt_tokens)),
        "completion_tokens": max(0, int(completion_tokens)),
        "estimated_prompt_tokens": max(0, int(estimated_prompt_tokens)),
        "estimated_completion_tokens": max(0, int(estimated_completion_tokens)),
        "audio_ms": max(0, int(audio_ms)),
        "speech_ms": max(0, int(speech_ms)),
        "audio_chunks": max(0, int(audio_chunks)),
        "tts_chars": max(0, int(tts_chars)),
        "tts_audio_ms": max(0, int(tts_audio_ms)),
        "image_count": max(0, int(image_count)),
        "event_json": json.dumps(details or {}, ensure_ascii=False),
        "created_at": now_ms(),
    }
    event_payload["total_tokens"] = event_payload["prompt_tokens"] + event_payload["completion_tokens"]
    with connect() as connection:
        connection.execute(
            """
            INSERT INTO usage_events (
                id, conversation_id, user_id, provider, model, modality, metric_type,
                prompt_tokens, completion_tokens, total_tokens,
                estimated_prompt_tokens, estimated_completion_tokens,
                audio_ms, speech_ms, audio_chunks, tts_chars, tts_audio_ms,
                image_count, event_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event_payload["id"],
                event_payload["conversation_id"],
                event_payload["user_id"],
                event_payload["provider"],
                event_payload["model"],
                event_payload["modality"],
                event_payload["metric_type"],
                event_payload["prompt_tokens"],
                event_payload["completion_tokens"],
                event_payload["total_tokens"],
                event_payload["estimated_prompt_tokens"],
                event_payload["estimated_completion_tokens"],
                event_payload["audio_ms"],
                event_payload["speech_ms"],
                event_payload["audio_chunks"],
                event_payload["tts_chars"],
                event_payload["tts_audio_ms"],
                event_payload["image_count"],
                event_payload["event_json"],
                event_payload["created_at"],
            ),
        )


def list_usage_stats(user_id: str, days: int = 7) -> dict[str, Any]:
    safe_days = max(1, min(days, 90))
    end = now_ms()
    start = end - safe_days * 24 * 60 * 60 * 1000
    with connect() as connection:
        totals = dict(
            connection.execute(
                """
                SELECT
                    COUNT(*) AS event_count,
                    COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                    COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                    COALESCE(SUM(total_tokens), 0) AS total_tokens,
                    COALESCE(SUM(estimated_prompt_tokens), 0) AS estimated_prompt_tokens,
                    COALESCE(SUM(estimated_completion_tokens), 0) AS estimated_completion_tokens,
                    COALESCE(SUM(audio_ms), 0) AS audio_ms,
                    COALESCE(SUM(speech_ms), 0) AS speech_ms,
                    COALESCE(SUM(audio_chunks), 0) AS audio_chunks,
                    COALESCE(SUM(tts_chars), 0) AS tts_chars,
                    COALESCE(SUM(tts_audio_ms), 0) AS tts_audio_ms,
                    COALESCE(SUM(image_count), 0) AS image_count
                FROM usage_events
                WHERE user_id = ? AND created_at >= ?
                """,
                (user_id, start),
            ).fetchone()
        )
        modality_rows = connection.execute(
            """
            SELECT
                modality,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(estimated_prompt_tokens), 0) AS estimated_prompt_tokens,
                COALESCE(SUM(estimated_completion_tokens), 0) AS estimated_completion_tokens,
                COALESCE(SUM(audio_ms), 0) AS audio_ms,
                COALESCE(SUM(speech_ms), 0) AS speech_ms,
                COALESCE(SUM(tts_chars), 0) AS tts_chars,
                COALESCE(SUM(tts_audio_ms), 0) AS tts_audio_ms,
                COALESCE(SUM(image_count), 0) AS image_count,
                COUNT(*) AS event_count
            FROM usage_events
            WHERE user_id = ? AND created_at >= ?
            GROUP BY modality
            ORDER BY event_count DESC
            """,
            (user_id, start),
        ).fetchall()
        conversation_rows = connection.execute(
            """
            SELECT
                c.id,
                c.title,
                MAX(u.created_at) AS last_used_at,
                COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(u.completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(u.estimated_prompt_tokens), 0) AS estimated_prompt_tokens,
                COALESCE(SUM(u.estimated_completion_tokens), 0) AS estimated_completion_tokens,
                COALESCE(SUM(u.audio_ms), 0) AS audio_ms,
                COALESCE(SUM(u.speech_ms), 0) AS speech_ms,
                COALESCE(SUM(u.tts_chars), 0) AS tts_chars,
                COALESCE(SUM(u.tts_audio_ms), 0) AS tts_audio_ms,
                COALESCE(SUM(u.image_count), 0) AS image_count,
                COUNT(u.id) AS event_count
            FROM usage_events u
            JOIN conversations c ON c.id = u.conversation_id AND c.user_id = u.user_id
            WHERE u.user_id = ? AND u.created_at >= ?
            GROUP BY c.id
            ORDER BY last_used_at DESC
            LIMIT 8
            """,
            (user_id, start),
        ).fetchall()
        recent_rows = connection.execute(
            """
            SELECT provider, model, modality, metric_type, prompt_tokens, completion_tokens,
                   estimated_prompt_tokens, estimated_completion_tokens, audio_ms, speech_ms,
                   tts_chars, tts_audio_ms, image_count, created_at
            FROM usage_events
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 12
            """,
            (user_id,),
        ).fetchall()

    totals["estimated_units"] = estimate_units_from_usage(totals)
    return {
        "period_start": start,
        "period_end": end,
        "generated_at": end,
        "days": safe_days,
        "totals": totals,
        "modalities": [decorate_usage_bucket(dict(row)) for row in modality_rows],
        "conversations": [decorate_usage_bucket(dict(row)) for row in conversation_rows],
        "recent_events": [dict(row) for row in recent_rows],
    }


def estimate_units_from_usage(usage: dict[str, Any]) -> float:
    prompt_tokens = int(usage.get("prompt_tokens") or usage.get("estimated_prompt_tokens") or 0)
    completion_tokens = int(usage.get("completion_tokens") or usage.get("estimated_completion_tokens") or 0)
    speech_ms = int(usage.get("speech_ms") or usage.get("audio_ms") or 0)
    image_count = int(usage.get("image_count") or 0)
    tts_chars = int(usage.get("tts_chars") or 0)
    return round(speech_ms / 60000 * 1.0 + image_count * 4.0 + (prompt_tokens + completion_tokens) / 1000 + tts_chars / 1000 * 0.3, 2)


def decorate_usage_bucket(row: dict[str, Any]) -> dict[str, Any]:
    row["estimated_units"] = estimate_units_from_usage(row)
    return row


def touch_conversation(connection: sqlite3.Connection, user_id: str, conversation_id: str, updated_at: int) -> None:
    connection.execute(
        "UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?",
        (updated_at, conversation_id, user_id),
    )


def decorate_conversation(conversation: dict[str, Any]) -> dict[str, Any]:
    conversation["message_count"] = int(conversation.get("message_count") or 0)
    conversation.pop("latest_vision_json", None)
    conversation["latest_cost"] = json.loads(conversation.pop("latest_cost_json", "{}") or "{}")
    return conversation
