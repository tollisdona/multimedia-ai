from __future__ import annotations

import sqlite3
import json
from pathlib import Path
from typing import Any
from uuid import uuid4

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
