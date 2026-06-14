class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.inputFrameSize = Math.round(sampleRate * 0.04);
    this.outputSampleRate = 16000;
    this.outputFrameSize = Math.round(this.outputSampleRate * 0.04);
    this.noiseFloor = 0.006;
    this.isSpeech = false;
    this.hotFrames = 0;
    this.coldFrames = 0;
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
    while (this.buffer.length >= this.inputFrameSize) {
      const slice = this.buffer.splice(0, this.inputFrameSize);
      let sum = 0;
      const pcm = new Int16Array(this.outputFrameSize);
      for (let i = 0; i < slice.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, slice[i]));
        sum += sample * sample;
      }
      for (let i = 0; i < this.outputFrameSize; i += 1) {
        const position = (i / Math.max(this.outputFrameSize - 1, 1)) * (slice.length - 1);
        const left = Math.floor(position);
        const right = Math.min(left + 1, slice.length - 1);
        const weight = position - left;
        const sample = Math.max(-1, Math.min(1, slice[left] * (1 - weight) + slice[right] * weight));
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      const rms = Math.sqrt(sum / slice.length);
      const floorAlpha = this.isSpeech || rms > this.noiseFloor * 2.2 ? 0.995 : 0.94;
      this.noiseFloor = this.noiseFloor * floorAlpha + rms * (1 - floorAlpha);
      const threshold = Math.max(0.012, this.noiseFloor * 2.8);
      if (rms > threshold) {
        this.hotFrames += 1;
        this.coldFrames = 0;
      } else {
        this.coldFrames += 1;
        this.hotFrames = 0;
      }
      const wasSpeech = this.isSpeech;
      if (!this.isSpeech && this.hotFrames >= 3) this.isSpeech = true;
      if (this.isSpeech && this.coldFrames >= 14) this.isSpeech = false;
      this.port.postMessage(
        {
          pcm,
          rms,
          noiseFloor: this.noiseFloor,
          isSpeech: this.isSpeech,
          speechStart: !wasSpeech && this.isSpeech,
          speechEnd: wasSpeech && !this.isSpeech,
          sampleRate: this.outputSampleRate,
          durationMs: Math.round((pcm.length / this.outputSampleRate) * 1000),
        },
        [pcm.buffer],
      );
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
