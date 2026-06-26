"use strict";

// Setup completion into workspace smoke suite for Podcast Design Canvas (#149).
// Run with: `node tests/setup-workspace-handoff.test.js`.

const assert = require("assert");
const setup = require("../app/episode-setup.js");
const style = require("../app/episode-style.js");
const workspace = require("../app/episode-workspace.js");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

function completeDraft() {
  const draft = setup.createDraft();
  draft.episodeName = "Founders Unfiltered — Episode 1";
  draft.riversideLink = "https://riverside.fm/studio/founders-ep1";
  draft.speakers.forEach((speaker, index) => {
    speaker.name = ["Sam Rivera", "Dana Kim", "Alex Chen"][index];
  });
  draft.speakers[0].social.website = "https://sam.example";
  return draft;
}

function prepareProbePresetHandoff(draft, showName) {
  return setup.prepareSandboxPresetHandoff(draft, { showName: showName || "Probe Show" });
}

test("buildSetupCompletionHandoff carries episode title, preset, source, and roles", () => {
  const summary = setup.summarize(completeDraft());
  const completion = setup.buildSetupCompletionHandoff(summary, { presetSummary: "Studio Spotlight · Side by side" });
  assert.strictEqual(completion.completionEyebrow, "Setup complete");
  assert.strictEqual(completion.episodeTitle, "Founders Unfiltered — Episode 1");
  assert.ok(completion.presetSummary.includes("Studio Spotlight"));
  assert.ok(completion.handoff.sourceDetail.includes("riverside.fm"));
  assert.ok(completion.roleSummary.includes("Sam Rivera"));
  assert.ok(completion.roleSummary.includes("Host"));
});

test("applySandboxHandoffSource attaches a valid Riverside demo link when source is blank", () => {
  const draft = setup.createDraft();
  assert.strictEqual(trim(draft.riversideLink), "");
  const next = setup.applySandboxHandoffSource(draft);
  assert.ok(setup.isLikelyUrl(next.riversideLink));
  assert.ok(next.riversideLink.includes("riverside.fm"));
  assert.strictEqual(setup.canApplyImportContinueDefaults(next), true);
});

test("ACCEPTANCE: preset-first probe path validates and produces workspace handoff data", () => {
  const ready = prepareProbePresetHandoff(setup.createDraft(), "Sandbox Show");
  const validation = setup.validateDraft(ready);
  assert.strictEqual(validation.ok, true, validation.messages.join("; "));

  const selection = style.createSelection();
  const presetSummary = style.summarizeStyle(selection, ready.speakers.length).presetName;
  assert.ok(presetSummary.length > 0);

  const summary = setup.summarize(ready);
  const completion = setup.buildSetupCompletionHandoff(summary, { presetSummary });
  assert.strictEqual(completion.completionEyebrow, "Setup complete");
  assert.ok(completion.episodeTitle.includes("Episode 1"));
  assert.strictEqual(completion.presetSummary, presetSummary);
  assert.ok(completion.roleSummary.includes("Host"));
  assert.ok(completion.roleSummary.includes("Guest 1"));
  assert.ok(completion.handoff.sourceDetail.includes("riverside.fm"));

  const ws = workspace.buildWorkspace(summary, { contextApproved: false });
  const setupStage = workspace.getStage(ws, "setup");
  assert.ok(setupStage.summary.includes("Host"));
  assert.ok(setupStage.summary.includes("riverside.fm"));
});

test("ACCEPTANCE: preset selection completes sandbox handoff without manual Continue input", () => {
  const ready = setup.prepareSandboxPresetHandoff(setup.createDraft(), "Sandbox Show");
  assert.strictEqual(setup.validateDraft(ready).ok, true);
  const selection = style.applyPresetToSelection(style.createSelection(), "split-stage", false);
  const presetSummary = style.summarizeStyle(selection, ready.speakers.length).presetName;
  const completion = setup.buildSetupCompletionHandoff(setup.summarize(ready), { presetSummary });
  assert.strictEqual(completion.completionEyebrow, "Setup complete");
  assert.ok(completion.presetSummary.length > 0);
  assert.ok(completion.roleSummary.includes("Host"));
  assert.ok(completion.handoff.sourceDetail.includes("riverside.fm"));
});

test("ACCEPTANCE: riverside-only path still completes setup handoff recap", () => {
  const draft = setup.createDraft();
  draft.riversideLink = "https://riverside.fm/studio/probe-only";
  const ready = setup.applyImportContinueDefaults(draft, { showName: "Probe Show" });
  assert.strictEqual(setup.validateDraft(ready).ok, true);

  const presetSummary = style.summarizeStyle(style.createSelection(), ready.speakers.length).presetName;
  const completion = setup.buildSetupCompletionHandoff(setup.summarize(ready), { presetSummary });
  assert.strictEqual(completion.completionEyebrow, "Setup complete");
  assert.ok(completion.episodeTitle.includes("Episode 1"));
  assert.ok(completion.presetSummary.length > 0);
});

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

console.log(`\nsetup workspace handoff: ${passed} assertions passed`);
