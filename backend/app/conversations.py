from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field

from .auth import current_user
from .db import (
    create_conversation,
    delete_conversation,
    get_conversation,
    list_conversations,
    list_messages,
    update_conversation_title,
)


router = APIRouter(prefix="/api/conversations", tags=["conversations"])


class ConversationCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    title: str = Field(default="新会话", max_length=80)


class ConversationUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=80)


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


def get_owned_conversation_or_404(user_id: str, conversation_id: str) -> dict[str, Any]:
    conversation = get_conversation(user_id, conversation_id)
    if not conversation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return conversation


@router.get("", response_model=list[ConversationOut])
async def conversations(user: dict[str, Any] = Depends(current_user)) -> list[ConversationOut]:
    return [public_conversation(item) for item in list_conversations(str(user["id"]))]


@router.post("", response_model=ConversationOut)
async def new_conversation(payload: ConversationCreate, user: dict[str, Any] = Depends(current_user)) -> ConversationOut:
    return public_conversation(create_conversation(str(user["id"]), payload.title))


@router.get("/{conversation_id}", response_model=ConversationOut)
async def conversation(conversation_id: str, user: dict[str, Any] = Depends(current_user)) -> ConversationOut:
    return public_conversation(get_owned_conversation_or_404(str(user["id"]), conversation_id))


@router.patch("/{conversation_id}", response_model=ConversationOut)
async def rename_conversation(
    conversation_id: str,
    payload: ConversationUpdate,
    user: dict[str, Any] = Depends(current_user),
) -> ConversationOut:
    conversation = update_conversation_title(str(user["id"]), conversation_id, payload.title)
    if not conversation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return public_conversation(conversation)


@router.delete("/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
async def remove_conversation(conversation_id: str, user: dict[str, Any] = Depends(current_user)) -> Response:
    if not delete_conversation(str(user["id"]), conversation_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{conversation_id}/messages", response_model=list[MessageOut])
async def messages(conversation_id: str, user: dict[str, Any] = Depends(current_user)) -> list[MessageOut]:
    get_owned_conversation_or_404(str(user["id"]), conversation_id)
    return [public_message(item) for item in list_messages(str(user["id"]), conversation_id)]
