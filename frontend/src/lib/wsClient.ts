import type { GatewayEvent } from "../types";

type Handler = (event: GatewayEvent) => void;
type StatusHandler = (state: string) => void;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private statusHandlers = new Set<StatusHandler>();
  private pending: string[] = [];
  private manualClose = false;
  private reconnectTimer = 0;

  constructor(private readonly url: string) {}

  connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.manualClose = false;
    this.ws = new WebSocket(this.url);
    this.emitStatus();
    this.ws.onopen = () => {
      this.emitStatus();
      const queued = this.pending.splice(0, 80);
      queued.forEach((message) => this.ws?.send(message));
    };
    this.ws.onmessage = (message) => {
      const data = JSON.parse(message.data) as GatewayEvent;
      this.handlers.forEach((handler) => handler(data));
    };
    this.ws.onerror = () => {
      this.emitStatus();
    };
    this.ws.onclose = () => {
      this.emitStatus();
      if (!this.manualClose) {
        window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = window.setTimeout(() => this.connect(), 1200);
      }
    };
  }

  on(handler: Handler) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onStatus(handler: StatusHandler) {
    this.statusHandlers.add(handler);
    handler(this.state);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  send(type: string, payload: Record<string, unknown> = {}) {
    const message = JSON.stringify({ type, ...payload });
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (type === "audio.input.chunk") return false;
      this.pending.push(message);
      this.pending = this.pending.slice(-80);
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) this.connect();
      return false;
    }
    this.ws.send(message);
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
    this.manualClose = true;
    window.clearTimeout(this.reconnectTimer);
    this.pending = [];
    this.ws?.close();
    this.ws = null;
    this.emitStatus();
  }

  get state() {
    if (!this.ws) return "closed";
    return ["connecting", "open", "closing", "closed"][this.ws.readyState] ?? "closed";
  }

  private emitStatus() {
    this.statusHandlers.forEach((handler) => handler(this.state));
  }
}
