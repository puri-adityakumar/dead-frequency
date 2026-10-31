import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DfSynth } from '../src/audio/synth';
import type { SoundCue } from '../src/shared/contracts';

test('audio is gesture-gated, starts ambience, handles every cue, and disposes once', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const sources: Array<{ starts: number; stops: number }> = [];
  let constructed = 0;
  let closed = 0;
  const parameter = () => ({
    value: 0,
    cancelScheduledValues() {}, setValueAtTime() {},
    linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
  });
  const node = () => ({ connect() {}, disconnect() {} });
  const source = () => {
    const stats = { starts: 0, stops: 0 };
    sources.push(stats);
    return {
      ...node(), frequency: parameter(), type: 'sine', buffer: null, loop: false,
      start() { stats.starts += 1; }, stop() { stats.stops += 1; },
    };
  };
  class FakeAudioContext {
    state = 'running'; currentTime = 10; sampleRate = 128;
    destination = node();
    constructor() { constructed += 1; }
    createGain() { return { ...node(), gain: parameter() }; }
    createOscillator() { return source(); }
    createBufferSource() { return source(); }
    createBiquadFilter() { return { ...node(), frequency: parameter(), Q: parameter(), type: 'lowpass' }; }
    createBuffer(_channels: number, length: number) { return { getChannelData: () => new Float32Array(length) }; }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; closed += 1; }
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: { AudioContext: FakeAudioContext },
  });
  try {
    const synth = new DfSynth();
    synth.play('alarm');
    synth.setMuted(true);
    assert.equal(constructed, 0, 'No AudioContext before a gesture unlock');
    synth.unlock();
    assert.equal(constructed, 1);
    assert.equal(sources.length, 5, 'Three hum oscillators plus noise bed and gust oscillator');
    assert.ok(sources.every((s) => s.starts === 1), 'Every ambient source actually starts');
    synth.unlock();
    assert.equal(sources.length, 5, 'Repeated gestures do not duplicate ambience');
    synth.play('step');
    assert.equal(sources.length, 5, 'Muted cues do not allocate sources');
    synth.setMuted(false);
    const cues: SoundCue[] = ['step', 'relay', 'hurt', 'static', 'alarm', 'ending'];
    for (const cue of cues) synth.play(cue);
    assert.ok(sources.length > 5);
    assert.ok(sources.every((s) => s.starts === 1));
    const count = sources.length;
    synth.play('step');
    assert.equal(sources.length, count, 'Rapid repeated cues are throttled');
    synth.dispose();
    synth.dispose();
    assert.equal(closed, 1);
    assert.ok(sources.slice(0, 5).every((s) => s.stops === 1));
    synth.unlock();
    assert.equal(constructed, 1, 'Disposed synth cannot reopen a context');
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
