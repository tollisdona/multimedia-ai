import { GatewayClient } from "./wsClient";
import type { VadSnapshot } from "../types";

function int16ToBase64(input: Int16Array) {
  const bytes = new Uint8Array(input.buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export class AudioCapture {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private seq = 0;

  constructor(
    private readonly client: GatewayClient,
    private readonly onLevel: (rms: number) => void,
    private readonly onVad?: (snapshot: VadSnapshot) => void,
  ) {}

  async start(stream: MediaStream) {
    this.context = new AudioContext({ latencyHint: "interactive" });
    await this.context.audioWorklet.addModule("/audio-worklet.js");
    this.source = this.context.createMediaStreamSource(stream);
    this.worklet = new AudioWorkletNode(this.context, "pcm-capture");
    this.worklet.port.onmessage = (event) => {
      const { pcm, rms, sampleRate, durationMs, noiseFloor, isSpeech, speechStart, speechEnd } = event.data as {
        pcm: Int16Array;
        rms: number;
        sampleRate: number;
        durationMs: number;
        noiseFloor: number;
        isSpeech: boolean;
        speechStart: boolean;
        speechEnd: boolean;
      };
      this.onLevel(rms);
      this.client.send("audio.input.chunk", {
        seq: this.seq,
        sampleRate,
        durationMs,
        rms,
        encoding: "pcm16",
        audio: int16ToBase64(pcm),
      });
      this.onVad?.({ rms, noiseFloor, isSpeech, speechStart, speechEnd });
      this.seq += 1;
    };
    this.source.connect(this.worklet);
  }

  async stop() {
    this.worklet?.disconnect();
    this.source?.disconnect();
    await this.context?.close();
    this.worklet = null;
    this.source = null;
    this.context = null;
  }
}
