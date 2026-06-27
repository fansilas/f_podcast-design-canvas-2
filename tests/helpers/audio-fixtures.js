"use strict";

// Shared test helper (#197): builds an audio-polish summary for an episode whose
// imported speaker tracks have been processed into durable, fingerprint-bound
// polished assets — the export-ready audio state. Lives under tests/helpers/ so
// scripts/run-tests.mjs (which only discovers tests/*.test.js, no recursion)
// never executes it directly.

const audio = require("../../app/audio-polish.js");
const proc = require("../../app/audio-processor.js");

// A real 16-bit PCM WAV with genuine waveform content the DSP can measurably change.
function makeWav(seconds, freq) {
  const sr = 16000;
  const n = Math.floor(sr * seconds);
  const dataLen = n * 2;
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);
  function tag(o, s) { for (let i = 0; i < 4; i += 1) view.setUint8(o + i, s.charCodeAt(i)); }
  tag(0, "RIFF"); view.setUint32(4, 36 + dataLen, true); tag(8, "WAVE"); tag(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, "data"); view.setUint32(40, dataLen, true);
  let p = 44;
  for (let i = 0; i < n; i += 1) {
    const s = 0.4 * Math.sin(2 * Math.PI * (freq || 180) * (i / sr));
    view.setInt16(p, Math.round(s * 32767), true); p += 2;
  }
  return buffer;
}

// Process each imported track with the real engine and return the polished summary.
function treatedAudio(episode) {
  const tokened = Object.assign({}, episode, {
    speakers: (episode.speakers || []).map((s, i) => Object.assign({}, s, { mediaToken: `tok-${i + 1}` })),
  });
  let polish = audio.createPolish(tokened);
  polish.speakers.forEach((track) => {
    const r = proc.processTrack(makeWav(1, 140 + track.trackIndex * 50), polish);
    polish = audio.setTrackStatus(polish, track.trackIndex, "complete", {
      sourceFingerprint: r.metrics.sourceFingerprint,
      outputFingerprint: r.metrics.outputFingerprint,
      rmsDeltaDb: r.metrics.rmsDeltaDb,
      durationMs: r.metrics.durationMs,
      byteLength: r.metrics.outputBytes,
    });
  });
  return audio.summarizePolish(polish);
}

module.exports = { makeWav, treatedAudio };
