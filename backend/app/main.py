from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from .auth import authenticate_token, me_router, router as auth_router
from .db import init_db
from .gateway import GatewayConnection


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
    connection = GatewayConnection(websocket, user_id=str(user["id"]))
    await connection.run()
