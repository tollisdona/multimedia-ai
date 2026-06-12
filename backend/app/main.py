from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from .gateway import GatewayConnection


app = FastAPI(title="AI Vision Conversation Gateway")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    connection = GatewayConnection(websocket)
    await connection.run()
