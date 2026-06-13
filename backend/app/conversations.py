from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from .auth import current_user
from .db import create_conversation, get_conversation, list_conversations, list_messages


router = APIRouter(prefix="/api/conversations", tags=["conversations"])


class ConversationCreate(BaseModel):
    title: str = Field(default="新会话", max_length=80)


class ConversationOut(BaseModel):
    id: str
    title: str
    createdAt: int
    updatedAt: int
    messageCount: int
    latestCost: dict[str, Any]


class MessageOut(BaseModel):
    id: str
    role: str
    text: str
    createdAt: int


def public_conversation(conversation: dict[str, Any]) -> ConversationOut:
    return ConversationOut(
        id=str(conversation["id"]),
        title=str(conversation["title"]),
        createdAt=int(conversation["created_at"]),
        updatedAt=int(conversation["updated_at"]),
        messageCount=int(conversation["message_count"]),
        latestCost=dict(conversation["latest_cost"]),
    )


def public_message(message: dict[str, Any]) -> MessageOut:
    return MessageOut(
        id=str(message["id"]),
        role=str(message["role"]),
        text=str(message["text"]),
        createdAt=int(message["created_at"]),
    )


@router.get("", response_model=list[ConversationOut])
async def conversations(user: dict[str, Any] = Depends(current_user)) -> list[ConversationOut]:
    return [public_conversation(item) for item in list_conversations(str(user["id"]))]


@router.post("", response_model=ConversationOut)
async def new_conversation(payload: ConversationCreate, user: dict[str, Any] = Depends(current_user)) -> ConversationOut:
    return public_conversation(create_conversation(str(user["id"]), payload.title))


@router.get("/{conversation_id}/messages", response_model=list[MessageOut])
async def messages(conversation_id: str, user: dict[str, Any] = Depends(current_user)) -> list[MessageOut]:
    if not get_conversation(str(user["id"]), conversation_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return [public_message(item) for item in list_messages(str(user["id"]), conversation_id)]
