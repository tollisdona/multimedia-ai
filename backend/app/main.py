from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from .auth import authenticate_token, me_router, router as auth_router
from .conversations import router as conversations_router
from .db import create_conversation, get_conversation, init_db
from .gateway import GatewayConnection
from .model_config import router as model_config_router
from .usage import router as usage_router


app = FastAPI(title="AI Vision Conversation Gateway")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(auth_router)
app.include_router(me_router)
app.include_router(conversations_router)
app.include_router(model_config_router)
app.include_router(usage_router)


@app.on_event("startup")
async def startup() -> None:
    init_db()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    user = authenticate_token(websocket.query_params.get("token"))
    if not user:
        await websocket.close(code=4401)
        return
    user_id = str(user["id"])
    conversation_id = str(websocket.query_params.get("conversationId") or "")
    conversation = get_conversation(user_id, conversation_id) if conversation_id else None
    if not conversation:
        conversation = create_conversation(user_id, "新会话")
    connection = GatewayConnection(websocket, user_id=user_id, conversation_id=str(conversation["id"]))
    await connection.run()
