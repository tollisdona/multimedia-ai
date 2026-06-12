class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.frameSize = Math.round(sampleRate * 0.04);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) {
      return true;
    }
    const channel = input[0];
    for (let i = 0; i < channel.length; i += 1) {
      this.buffer.push(channel[i]);
    }
    while (this.buffer.length >= this.frameSize) {
      const slice = this.buffer.splice(0, this.frameSize);
      let sum = 0;
      const pcm = new Int16Array(slice.length);
      for (let i = 0; i < slice.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, slice[i]));
        sum += sample * sample;
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      this.port.postMessage(
        {
          pcm,
          rms: Math.sqrt(sum / slice.length),
          sampleRate,
          durationMs: Math.round((slice.length / sampleRate) * 1000),
        },
        [pcm.buffer],
      );
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
