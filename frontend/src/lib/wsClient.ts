import type { GatewayEvent } from "../types";

type Handler = (event: GatewayEvent) => void;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();

  constructor(private readonly url: string) {}

  connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (message) => {
      const data = JSON.parse(message.data) as GatewayEvent;
      this.handlers.forEach((handler) => handler(data));
    };
  }

  on(handler: Handler) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  send(type: string, payload: Record<string, unknown> = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type, ...payload }));
    return true;
  }

  waitOpen(timeoutMs = 4000) {
    return new Promise<void>((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("WebSocket is not connected"));
        return;
      }
      if (this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      const timer = window.setTimeout(() => reject(new Error("WebSocket open timeout")), timeoutMs);
      this.ws.addEventListener(
        "open",
        () => {
          window.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.ws.addEventListener(
        "error",
        () => {
          window.clearTimeout(timer);
          reject(new Error("WebSocket connection failed"));
        },
        { once: true },
      );
    });
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }

  get state() {
    if (!this.ws) return "closed";
    return ["connecting", "open", "closing", "closed"][this.ws.readyState] ?? "closed";
  }
}
