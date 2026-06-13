function base64ToInt16(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

export class PcmStreamPlayer {
  private context: AudioContext | null = null;
  private nextStartAt = 0;
  private activeSources = new Set<AudioBufferSourceNode>();

  constructor(
    private readonly onStart: () => void,
    private readonly onIdle: () => void,
  ) {}

  async play(base64: string, sampleRate = 24000) {
    const pcm = base64ToInt16(base64);
    if (pcm.length === 0) return;
    const context = this.context ?? new AudioContext({ latencyHint: "interactive", sampleRate });
    this.context = context;
    if (context.state === "suspended") await context.resume();

    const buffer = context.createBuffer(1, pcm.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) {
      channel[i] = Math.max(-1, Math.min(1, pcm[i] / 32768));
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      this.activeSources.delete(source);
      if (this.activeSources.size === 0) this.onIdle();
    };

    const startAt = Math.max(context.currentTime + 0.02, this.nextStartAt);
    this.nextStartAt = startAt + buffer.duration;
    this.activeSources.add(source);
    this.onStart();
    source.start(startAt);
  }

  stop() {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // Ignore sources that have already ended.
      }
    }
    this.activeSources.clear();
    this.nextStartAt = this.context?.currentTime ?? 0;
    this.onIdle();
  }
}
