import { base64ToInt16 } from "./audio";

/** Schedules incoming 24kHz PCM16 chunks back-to-back for gapless playback. */
export class PcmPlayer {
  private nextStartTime = 0;
  private scheduled: AudioBufferSourceNode[] = [];

  constructor(
    private ctx: AudioContext,
    private outputNode: AudioNode
  ) {}

  playChunk(base64Pcm24k: string) {
    const int16 = base64ToInt16(base64Pcm24k);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      const s = int16[i]!;
      float32[i] = s / (s < 0 ? 0x8000 : 0x7fff);
    }
    // ASSUMPTION: Gemini Live output is 24kHz mono PCM16 — verify at runtime;
    // if playback sounds pitched/sped wrong, change this rate first.
    const buffer = this.ctx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.outputNode);

    const startAt = Math.max(this.ctx.currentTime, this.nextStartTime);
    src.start(startAt);
    this.nextStartTime = startAt + buffer.duration;

    this.scheduled.push(src);
    src.onended = () => {
      this.scheduled = this.scheduled.filter((n) => n !== src);
    };
  }

  /** Gemini "interrupted" (barge-in): drop anything not yet played. */
  interrupt() {
    const now = this.ctx.currentTime;
    for (const src of this.scheduled) {
      try {
        src.stop(now);
      } catch {}
    }
    this.scheduled = [];
    this.nextStartTime = now;
  }
}
