/**
 * Dead Frequency — procedural Web Audio director.
 *
 * Every voice (hum, static, steps, relay chime, hurt, alarm, ending) is
 * synthesized at runtime with oscillators and filtered noise buffers: no
 * samples, downloads, or remote assets.
 *
 * Hard rules enforced here:
 * - Nothing is created or resumed until `unlock()` is called from a real user
 *   gesture (autoplay policies); `play()`/`setMuted()` are safe no-ops before that.
 * - `dispose()` fully tears the context down (strict-mode double unmounts are safe).
 * - Per-cue throttle keeps rapid engine loops (footsteps) from turning into mush.
 */
import type { SoundCue } from '@/shared/contracts';

const MASTER_LEVEL = 0.85;

/** Minimum gap between repeats of the same cue, in milliseconds. */
const CUE_THROTTLE_MS: Record<SoundCue, number> = {
  step: 85,
  relay: 160,
  hurt: 220,
  static: 320,
  alarm: 850,
  ending: 2400,
};

interface ToneOptions {
  type: OscillatorType;
  f0: number;
  /** Optional frequency glide target (pitch drop / rise). */
  f1?: number;
  /** Start offset from "now", in seconds. */
  offset?: number;
  dur: number;
  peak: number;
  /** Low-pass the oscillator (tames square waves). */
  lpf?: number;
}

interface NoiseOptions {
  type: BiquadFilterType;
  f0: number;
  f1?: number;
  q?: number;
  offset?: number;
  dur: number;
  peak: number;
}

export class DfSynth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambientSources: AudioScheduledSourceNode[] = [];
  private ambient: { humGain: GainNode; bedGain: GainNode } | null = null;
  private noise: AudioBuffer | null = null;
  private muted = false;
  private dead = false;
  private lastAt: Partial<Record<SoundCue, number>> = {};

  get unlocked(): boolean {
    return this.ctx !== null;
  }

  /** Create or resume the AudioContext. Call from a user-gesture handler. */
  unlock(): void {
    if (this.dead || typeof window === 'undefined') return;
    if (!this.ctx) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : MASTER_LEVEL;
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => undefined);
    }
    this.ensureNoise();
    this.startAmbient();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    const gain = this.master?.gain;
    if (!gain) return;
    const t = this.ctx!.currentTime;
    gain.cancelScheduledValues(t);
    gain.setValueAtTime(gain.value, t);
    gain.linearRampToValueAtTime(muted ? 0 : MASTER_LEVEL, t + 0.08);
  }

  /**
   * Fire a cue. Safe before unlock: silently ignored until the context exists
   * and belongs to a user gesture.
   */
  play(cue: SoundCue): void {
    if (this.dead || this.muted) return;
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || ctx.state === 'closed') return;
    const now = ctx.currentTime;
    const last = this.lastAt[cue];
    if (last !== undefined && (now - last) * 1000 < CUE_THROTTLE_MS[cue]) return;
    this.lastAt[cue] = now;

    switch (cue) {
      case 'step':
        this.voiceStep();
        break;
      case 'relay':
        this.voiceRelay();
        break;
      case 'hurt':
        this.voiceHurt();
        break;
      case 'static':
        this.voiceStatic();
        break;
      case 'alarm':
        this.voiceAlarm();
        break;
      case 'ending':
        this.voiceEnding();
        break;
    }
  }

  /** Tear everything down. Idempotent; safe from unmount cleanup. */
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.stopAmbient();
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.ambient = null;
    if (ctx && ctx.state !== 'closed') {
      void ctx.close().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- internals

  private ensureNoise(): void {
    if (!this.ctx || this.noise) return;
    const ctx = this.ctx;
    const length = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noise = buffer;
  }

  /** Facility ambience: beating low hum + thin band-passed static bed. */
  private startAmbient(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.ambientSources.length > 0) return;

    const humGain = ctx.createGain();
    humGain.gain.value = 0.05;
    const o1 = ctx.createOscillator();
    o1.type = 'sine';
    o1.frequency.value = 54;
    const o2 = ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = 57.5;
    const o2Level = ctx.createGain();
    o2Level.gain.value = 0.4;
    o1.connect(humGain);
    o2.connect(o2Level);
    o2Level.connect(humGain);

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.02;
    lfo.connect(lfoDepth);
    lfoDepth.connect(humGain.gain);

    humGain.connect(master);

    const bedGain = ctx.createGain();
    bedGain.gain.value = 0.012;
    const bedFilter = ctx.createBiquadFilter();
    bedFilter.type = 'bandpass';
    bedFilter.frequency.value = 1500;
    bedFilter.Q.value = 0.35;
    const bed = this.noiseSource();
    if (bed) {
      bed.connect(bedFilter);
      bedFilter.connect(bedGain);
      bedGain.connect(master);
      const gust = ctx.createOscillator();
      gust.frequency.value = 0.11;
      const gustDepth = ctx.createGain();
      gustDepth.gain.value = 0.006;
      gust.connect(gustDepth);
      gustDepth.connect(bedGain.gain);
      bed.start();
      gust.start();
      this.ambientSources.push(bed, gust);
    }

    o1.start();
    o2.start();
    lfo.start();
    this.ambientSources.push(o1, o2, lfo);
    this.ambient = { humGain, bedGain };
  }

  private stopAmbient(): void {
    for (const source of this.ambientSources) {
      try {
        source.stop();
      } catch {
        // already stopped; nothing to do
      }
    }
    this.ambientSources = [];
    this.ambient = null;
  }

  private noiseSource(): AudioBufferSourceNode | null {
    if (!this.ctx || !this.noise) return null;
    const source = this.ctx.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    return source;
  }

  /** One oscillator voice with an exponential attack/decay envelope. */
  private tone(opts: ToneOptions): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime + (opts.offset ?? 0);
    const osc = ctx.createOscillator();
    osc.type = opts.type;
    osc.frequency.setValueAtTime(Math.max(1, opts.f0), t);
    if (opts.f1 !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.f1), t + opts.dur);
    }
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(opts.peak, t + Math.min(0.02, opts.dur * 0.3));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);

    let chain: AudioNode = osc;
    if (opts.lpf) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = opts.lpf;
      chain.connect(filter);
      chain = filter;
    }
    chain.connect(gain);
    gain.connect(master);
    osc.start(t);
    osc.stop(t + opts.dur + 0.05);
  }

  /** A shaped slice of the shared noise buffer through one biquad. */
  private noiseHit(opts: NoiseOptions): void {
    const ctx = this.ctx;
    const master = this.master;
    const source = this.noiseSource();
    if (!ctx || !master || !source) return;
    const t = ctx.currentTime + (opts.offset ?? 0);
    const filter = ctx.createBiquadFilter();
    filter.type = opts.type;
    filter.frequency.setValueAtTime(Math.max(1, opts.f0), t);
    if (opts.f1 !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(1, opts.f1), t + opts.dur);
    }
    filter.Q.value = opts.q ?? 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(opts.peak, t + Math.min(0.015, opts.dur * 0.25));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(t);
    source.stop(t + opts.dur + 0.05);
  }

  private voiceStep(): void {
    this.noiseHit({
      type: 'bandpass',
      f0: 700 + Math.random() * 500,
      q: 0.9,
      dur: 0.07 + Math.random() * 0.03,
      peak: 0.05,
    });
    this.tone({ type: 'sine', f0: 95 + Math.random() * 25, dur: 0.05, peak: 0.02 });
  }

  private voiceRelay(): void {
    // Restored-carrier chime: rising two-tone with a soft shimmer tail.
    this.tone({ type: 'sine', f0: 660, dur: 0.16, peak: 0.05 });
    this.tone({ type: 'sine', f0: 990, dur: 0.22, peak: 0.045, offset: 0.12 });
    this.tone({ type: 'triangle', f0: 1320, dur: 0.4, peak: 0.012, offset: 0.26 });
  }

  private voiceHurt(): void {
    this.tone({ type: 'sine', f0: 130, f1: 42, dur: 0.32, peak: 0.11 });
    this.noiseHit({ type: 'lowpass', f0: 420, q: 0.6, dur: 0.2, peak: 0.07 });
  }

  private voiceStatic(): void {
    // Radio tuning burst: swept band-pass plus a short high crackle.
    this.noiseHit({ type: 'bandpass', f0: 800, f1: 2600, q: 1.1, dur: 0.22, peak: 0.05 });
    this.noiseHit({ type: 'highpass', f0: 4200, q: 0.5, dur: 0.05, peak: 0.02 });
  }

  private voiceAlarm(): void {
    for (let i = 0; i < 4; i += 1) {
      this.tone({
        type: 'square',
        f0: i % 2 === 0 ? 620 : 470,
        dur: 0.16,
        peak: 0.035,
        lpf: 1600,
        offset: i * 0.19,
      });
    }
  }

  private voiceEnding(): void {
    // Low glissando send-off with a soft noise wash. Neutral on purpose: the
    // ending visuals carry release vs. shutdown, not the audio.
    this.tone({ type: 'sine', f0: 196, f1: 98, dur: 2.4, peak: 0.07 });
    this.tone({ type: 'sine', f0: 233, f1: 116, dur: 2.4, peak: 0.04, offset: 0.1 });
    this.noiseHit({ type: 'lowpass', f0: 500, q: 0.4, dur: 2.0, peak: 0.025, offset: 0.2 });
  }
}
