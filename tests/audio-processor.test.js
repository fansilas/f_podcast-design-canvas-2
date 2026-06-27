"use strict";

// Real audio-processing engine suite for Podcast Design Canvas (#197).
// Proves the polish pipeline decodes imported WAV bytes, applies genuine
// sample-level DSP, and re-encodes a NEW, valid, fingerprint-bound WAV asset —
// never a synthesized stand-in. Run with: `node tests/audio-processor.test.js`.

const assert = require("assert");
const proc = require("../app/audio-processor.js");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

// Build a real 16-bit PCM WAV in memory: a speech-like multi-formant signal with
// an amplitude envelope and a noise floor, so it is genuine waveform content
// (not a flat tone) that the DSP can measurably change.
function makeWav(seconds, sampleRate) {
  const sr = sampleRate || 16000;
  const n = Math.floor(sr * seconds);
  const blockAlign = 2;
  const dataLen = n * blockAlign;
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);
  function tag(o, s) { for (let i = 0; i < 4; i += 1) view.setUint8(o + i, s.charCodeAt(i)); }
  tag(0, "RIFF"); view.setUint32(4, 36 + dataLen, true); tag(8, "WAVE"); tag(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * blockAlign, true);
  view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true);
  tag(36, "data"); view.setUint32(40, dataLen, true);
  let p = 44;
  let seed = 1337;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    const env = 0.4 + 0.3 * Math.sin(2 * Math.PI * 2.3 * t); // syllable-rate envelope
    const voice = 0.5 * Math.sin(2 * Math.PI * 130 * t)
      + 0.3 * Math.sin(2 * Math.PI * 320 * t)
      + 0.2 * Math.sin(2 * Math.PI * 800 * t);
    const s = env * voice * 0.5 + rand() * 0.01; // small noise floor
    view.setInt16(p, Math.round(Math.max(-1, Math.min(1, s)) * 32767), true);
    p += 2;
  }
  return buffer;
}

const STUDIO = { noiseCleanup: "strong", leveling: "strong", speechClarity: "balanced", enhancement: "balanced" };
const NATURAL = { noiseCleanup: "light", leveling: "light", speechClarity: "light", enhancement: "light" };

test("decodeWav reads a 16-bit PCM WAV's format and full sample data", () => {
  const wav = makeWav(2);
  const decoded = proc.decodeWav(wav);
  assert.strictEqual(decoded.sampleRate, 16000);
  assert.strictEqual(decoded.channels, 1);
  assert.strictEqual(decoded.frameCount, 32000); // full 2s, not an excerpt
  assert.ok(decoded.data[0] instanceof Float32Array);
});

test("encodeWav round-trips to a valid, re-decodable WAV", () => {
  const decoded = proc.decodeWav(makeWav(1));
  const re = proc.encodeWav(decoded);
  const back = proc.decodeWav(re);
  assert.strictEqual(back.frameCount, decoded.frameCount);
  assert.strictEqual(back.sampleRate, decoded.sampleRate);
});

test("processTrack produces a real, valid, different WAV asset (not a stand-in)", () => {
  const wav = makeWav(3);
  const r = proc.processTrack(wav, STUDIO);
  // a real WAV with audio payload, not a 44-byte header or an id string
  assert.ok(r.outputBytes.byteLength > 44, "output has real audio payload");
  assert.strictEqual(proc.decodeWav(r.buffer).frameCount, proc.decodeWav(wav).frameCount);
  // the waveform genuinely changed
  assert.notStrictEqual(r.metrics.inputRms, r.metrics.outputRms);
  assert.ok(Math.abs(r.metrics.rmsDeltaDb) > 0.1, "measurable loudness change");
});

test("processTrack processes the FULL track length, not a bounded excerpt", () => {
  const wav = makeWav(6); // 6s source
  const r = proc.processTrack(wav, STUDIO);
  assert.strictEqual(r.metrics.durationMs, 6000);
  assert.strictEqual(proc.decodeWav(r.buffer).frameCount, 16000 * 6);
});

test("output is fingerprint-bound to its specific source", () => {
  const wav = makeWav(2);
  const r = proc.processTrack(wav, STUDIO);
  assert.strictEqual(r.metrics.sourceFingerprint, proc.fingerprint(wav));
  assert.notStrictEqual(r.metrics.sourceFingerprint, r.metrics.outputFingerprint);
  // a different source yields a different source fingerprint
  const other = proc.processTrack(makeWav(2, 22050), STUDIO);
  assert.notStrictEqual(other.metrics.sourceFingerprint, r.metrics.sourceFingerprint);
});

test("the chosen quality preset drives a different polished result", () => {
  const wav = makeWav(3);
  const studio = proc.processTrack(wav, STUDIO);
  const natural = proc.processTrack(wav, NATURAL);
  assert.notStrictEqual(studio.metrics.outputFingerprint, natural.metrics.outputFingerprint);
});

test("undecodable bytes throw rather than silently substituting audio", () => {
  assert.throws(() => proc.decodeWav(new Uint8Array([1, 2, 3, 4]).buffer));
  assert.throws(() => proc.processTrack(new Uint8Array([0, 0, 0, 0]).buffer, STUDIO));
});

test("ACCEPTANCE: imported WAV bytes are decoded, transformed, and re-encoded as a fingerprint-bound polished asset", () => {
  const imported = makeWav(4); // the creator's imported speaker track
  const sourcePrint = proc.fingerprint(imported);

  const result = proc.processTrack(imported, STUDIO);

  // 1. a genuine audio asset was produced from the real bytes
  assert.ok(result.outputBytes.byteLength > 44);
  const redecoded = proc.decodeWav(result.buffer);
  assert.strictEqual(redecoded.frameCount, 16000 * 4); // full length preserved
  // 2. it is a real transformation, measurable on the waveform
  assert.ok(Math.abs(result.metrics.rmsDeltaDb) > 0.1);
  assert.notStrictEqual(result.metrics.inputRms, result.metrics.outputRms);
  // 3. it is durably bound to THIS imported source, and distinct from it
  assert.strictEqual(result.metrics.sourceFingerprint, sourcePrint);
  assert.notStrictEqual(result.metrics.outputFingerprint, sourcePrint);
});

console.log(`\naudio processor: ${passed} assertions passed`);
