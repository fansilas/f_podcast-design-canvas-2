"use strict";

// End-to-end model suite for the #197 audio-polish processing handoff.
// Exercises: imported source bytes -> per-track real processing -> all-complete
// gating -> durable polished assets surfaced for export -> reload-safe persistence
// of every track (no last-write-wins) -> a missing-source track holds the step.
// Run with: `node tests/audio-polish-processing.test.js`.

const assert = require("assert");
const audio = require("../app/audio-polish.js");
const proc = require("../app/audio-processor.js");
const assets = require("../app/audio-assets.js");
const exporter = require("../app/episode-export.js");

assets._useMemoryBackend();

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

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
    const t = i / sr;
    const s = 0.4 * Math.sin(2 * Math.PI * (freq || 180) * t) * (0.5 + 0.4 * Math.sin(2 * Math.PI * 2 * t));
    view.setInt16(p, Math.round(s * 32767), true); p += 2;
  }
  return buffer;
}

// An episode summary whose speakers carry mediaTokens (set when real bytes were
// captured at import), matching what ES.summarize will thread through.
function importedEpisode() {
  return {
    episodeName: "Indie Makers Weekly — Episode 3",
    speakerCount: 3,
    sourceModeLabel: "Uploaded speaker files",
    speakers: [
      { role: "Host", name: "Jordan Lee", sourceLabel: "jordan.wav", mediaToken: "tok-1" },
      { role: "Guest 1", name: "Priya Shah", sourceLabel: "priya.wav", mediaToken: "tok-2" },
      { role: "Guest 2", name: "Chris Ortiz", sourceLabel: "chris.wav", mediaToken: "tok-3" },
    ],
  };
}

const EP_KEY = "show-1::ep-3";
const STUDIO = { noiseCleanup: "strong", leveling: "strong", speechClarity: "balanced", enhancement: "balanced" };

// Simulate the Apply handler at the model level: store source bytes, process each
// track, persist the polished asset, and advance per-track status.
async function runApply(polish, episodeKey) {
  let state = audio.applyPreset(polish, "studio");
  for (const track of state.speakers.slice()) {
    if (!audio.isProcessable(track)) continue;
    const src = await assets.getSource(episodeKey, track.trackIndex);
    const r = proc.processTrack(src.bytes, state);
    await assets.putPolished(episodeKey, track.trackIndex, {
      role: track.role, name: track.name, bytes: r.outputBytes,
      metrics: r.metrics, settings: { presetId: state.presetId },
    });
    state = audio.setTrackStatus(state, track.trackIndex, "complete", {
      sourceFingerprint: r.metrics.sourceFingerprint,
      outputFingerprint: r.metrics.outputFingerprint,
      rmsDeltaDb: r.metrics.rmsDeltaDb,
      durationMs: r.metrics.durationMs,
      byteLength: r.metrics.outputBytes,
    });
  }
  return state;
}

async function main() {
  await test("createPolish marks imported tracks pending and they are processable", () => {
    const polish = audio.createPolish(importedEpisode());
    assert.strictEqual(polish.speakers.length, 3);
    assert.ok(polish.speakers.every((t) => t.status === "pending"));
    assert.strictEqual(audio.processableCount(polish), 3);
    assert.strictEqual(audio.allTracksComplete(polish), false);
  });

  await test("each track is processed from its own stored source bytes", async () => {
    // seed distinct source bytes per track
    await assets.putSource(EP_KEY, 1, { bytes: new Uint8Array(makeWav(2, 150)) });
    await assets.putSource(EP_KEY, 2, { bytes: new Uint8Array(makeWav(2, 220)) });
    await assets.putSource(EP_KEY, 3, { bytes: new Uint8Array(makeWav(2, 300)) });
    const polish = audio.createPolish(importedEpisode());
    const done = await runApply(polish, EP_KEY);
    assert.ok(audio.allTracksComplete(done));
    assert.strictEqual(audio.completedCount(done), 3);
  });

  await test("summarizePolish exposes a durable polished asset per track, fingerprint-bound", async () => {
    const polish = audio.createPolish(importedEpisode());
    const done = await runApply(polish, EP_KEY);
    const summary = audio.summarizePolish(done);
    assert.strictEqual(summary.trackCount, 3);
    assert.strictEqual(summary.polishedAssets.length, 3);
    assert.ok(summary.allComplete);
    summary.polishedAssets.forEach((a) => {
      assert.ok(a.sourceFingerprint && a.outputFingerprint);
      assert.notStrictEqual(a.sourceFingerprint, a.outputFingerprint);
    });
    // assets are distinct per track (different sources => different fingerprints)
    const prints = summary.polishedAssets.map((a) => a.outputFingerprint);
    assert.strictEqual(new Set(prints).size, 3);
  });

  await test("every track's polished bytes persist independently (no last-write-wins)", async () => {
    const stored = await assets.listPolished(EP_KEY);
    assert.strictEqual(stored.length, 3, "all three polished tracks survive, not just the last");
    assert.deepStrictEqual(stored.map((s) => s.trackIndex), [1, 2, 3]);
    stored.forEach((s) => assert.ok(s.bytes && s.bytes.byteLength > 44));
  });

  await test("export readiness consumes the polished assets as the source", async () => {
    const polish = audio.createPolish(importedEpisode());
    const done = await runApply(polish, EP_KEY);
    const ctx = {
      audioPolish: audio.summarizePolish(done),
      appliedStyle: { presetName: "Studio Spotlight" },
    };
    assert.strictEqual(exporter.validateReadiness(ctx).ok, true);

    // a preset chosen but NOT processed must not be export-ready
    const unprocessed = audio.summarizePolish(audio.createPolish(importedEpisode()));
    const blocked = exporter.validateReadiness({ audioPolish: unprocessed, appliedStyle: { presetName: "Studio Spotlight" } });
    assert.strictEqual(blocked.ok, false);
    assert.ok(blocked.missing.indexOf("audio") >= 0);
  });

  await test("a track with no imported source holds the step (never auto-completes)", async () => {
    const ep = importedEpisode();
    ep.speakers[2].mediaToken = ""; // Chris uploaded nothing
    const polish = audio.createPolish(ep);
    assert.strictEqual(audio.processableCount(polish), 2);
    assert.strictEqual(polish.speakers[2].status, "no-source");
    // process only the two real tracks
    await assets.putSource(EP_KEY + "-x", 1, { bytes: new Uint8Array(makeWav(1, 150)) });
    await assets.putSource(EP_KEY + "-x", 2, { bytes: new Uint8Array(makeWav(1, 220)) });
    const done = await runApply(polish, EP_KEY + "-x");
    // both processable tracks complete, but the no-source track keeps it honest
    assert.strictEqual(audio.completedCount(done), 2);
    assert.strictEqual(done.speakers[2].status, "no-source");
  });

  await test("ACCEPTANCE: imported tracks process into durable polished assets that export consumes", async () => {
    const key = "accept::ep";
    await assets.putSource(key, 1, { bytes: new Uint8Array(makeWav(3, 140)) });
    await assets.putSource(key, 2, { bytes: new Uint8Array(makeWav(3, 240)) });
    await assets.putSource(key, 3, { bytes: new Uint8Array(makeWav(3, 360)) });

    const polish = audio.createPolish(importedEpisode());
    assert.strictEqual(audio.allTracksComplete(polish), false); // nothing applied yet

    const done = await runApply(polish, key);

    // step completes only after a saved polished asset exists for every track
    assert.ok(audio.allTracksComplete(done));
    const saved = await assets.listPolished(key);
    assert.strictEqual(saved.length, 3);

    // summary carries the durable, fingerprint-bound references...
    const summary = audio.summarizePolish(done);
    assert.strictEqual(summary.polishedAssets.length, 3);
    assert.ok(summary.polishedAssets.every((a) => a.outputFingerprint && a.sourceFingerprint));

    // ...and export both requires and consumes them
    const ready = exporter.validateReadiness({ audioPolish: summary, appliedStyle: { presetName: "Studio Spotlight" } });
    assert.strictEqual(ready.ok, true);
    const finalSummary = exporter.buildFinalSummary(importedEpisode(), { audioPolish: summary, appliedStyle: { presetName: "Studio Spotlight" } }, exporter.createExport(importedEpisode()));
    assert.ok(finalSummary.lines.some((l) => l.indexOf("Polished audio:") === 0 && l.indexOf("3/3") >= 0));
  });

  console.log(`\naudio polish processing: ${passed} assertions passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
