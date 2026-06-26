"use strict";

// Import-to-workspace handoff smoke suite for Podcast Design Canvas (#142).
// Run with: `node tests/import-handoff.test.js`.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const setup = require("../app/episode-setup.js");
const workspace = require("../app/episode-workspace.js");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

const ui = fs.readFileSync(path.join(__dirname, "../app/episode-setup.ui.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../app/styles.css"), "utf8");

function completeRiversideDraft() {
  const draft = setup.createDraft();
  draft.episodeName = "Founders Unfiltered — Episode 1";
  draft.riversideLink = "https://riverside.fm/studio/founders-ep1";
  draft.speakers[0].name = "Sam Rivera";
  draft.speakers[0].social.twitter = "https://x.com/samrivera";
  draft.speakers[1].name = "Dana Kim";
  draft.speakers[2].name = "Alex Chen";
  draft.speakers[2].social.linkedin = "https://linkedin.com/in/alexchen";
  return draft;
}

test("buildImportHandoff surfaces source, speaker identities, and social context", () => {
  const summary = setup.summarize(completeRiversideDraft());
  const handoff = setup.buildImportHandoff(summary);

  assert.ok(/imported sources/i.test(handoff.confirmationLead));
  assert.strictEqual(handoff.sourceLabel, "Riverside link");
  assert.ok(handoff.sourceDetail.includes("riverside.fm"));
  assert.strictEqual(handoff.speakers.length, 3);
  assert.strictEqual(handoff.speakers[0].identityLine, "Sam Rivera · Host");
  assert.ok(handoff.speakers[0].socialLine.includes("X:"));
  assert.strictEqual(handoff.speakers[1].socialLine, "No social links added");
  assert.strictEqual(handoff.socialLinkCount, 2);
});

test("buildImportHandoff reflects uploaded speaker files per bucket", () => {
  const draft = setup.createDraft();
  draft.episodeName = "Agency Weekly — Episode 1";
  draft.sourceMode = "upload";
  draft.speakers.forEach((speaker) => setup.attachPlaceholderFile(speaker));
  draft.speakers.forEach((speaker, index) => {
    speaker.name = `Speaker ${index + 1}`;
  });

  const handoff = setup.buildImportHandoff(setup.summarize(draft));
  assert.strictEqual(handoff.sourceLabel, "Uploaded speaker files");
  assert.deepStrictEqual(
    handoff.speakers.map((speaker) => speaker.sourceLabel),
    ["host-synced.mp4", "guest-1-synced.mp4", "guest-2-synced.mp4"],
  );
});

test("workspace setup stage summary names imported speakers and source", () => {
  const episode = setup.summarize(completeRiversideDraft());
  const ws = workspace.buildWorkspace(episode, { contextApproved: false });
  const setupStage = workspace.getStage(ws, "setup");

  assert.ok(setupStage.summary.includes("Sam Rivera (Host)"));
  assert.ok(setupStage.summary.includes("riverside.fm"));
  assert.ok(setupStage.summary.includes("2 social links saved"));
  assert.ok(setupStage.summary.includes("context ready to review"));
});

test("applyImportContinueDefaults completes a riverside draft when names are still blank", () => {
  const draft = setup.createDraft();
  draft.riversideLink = "https://riverside.fm/studio/review-path";
  assert.strictEqual(setup.canApplyImportContinueDefaults(draft), true);
  const ready = setup.applyImportContinueDefaults(draft, { showName: "Review Show" });
  assert.strictEqual(ready.episodeName, "Review Show — Episode 1");
  assert.deepStrictEqual(
    ready.speakers.map((speaker) => speaker.name),
    ["Host", "Guest 1", "Guest 2"],
  );
  assert.strictEqual(setup.validateDraft(ready).ok, true);
});

test("buildSetupCompletionHandoff marks setup complete for workspace recap", () => {
  const summary = setup.summarize(completeRiversideDraft());
  const completion = setup.buildSetupCompletionHandoff(summary, { presetSummary: "Studio Spotlight" });
  assert.strictEqual(completion.completionEyebrow, "Setup complete");
  assert.ok(completion.presetSummary.includes("Studio Spotlight"));
  assert.ok(completion.episodeTitle.includes("Episode 1"));
});

test("import handoff UI lands in workspace immediately after setup continue", () => {
  const handoffBlock = ui.slice(ui.indexOf("function tryCompleteSetupHandoff"), ui.indexOf("function onContinue()"));
  const continueBlock = ui.slice(ui.indexOf("function onContinue()"), ui.indexOf("function focusFirstError()"));
  assert.ok(handoffBlock.includes("renderWorkspace(summary)"));
  assert.ok(handoffBlock.includes("applySandboxHandoffSourceIfNeeded"));
  assert.ok(handoffBlock.includes("ensureSetupStyleApplied"));
  assert.ok(continueBlock.includes("tryCompleteSetupHandoff"));
  assert.ok(!/if \(SC && !contextApproved\)[\s\S]*renderContextReview\(summary\)/.test(handoffBlock));
  assert.ok(ui.includes("tryCompleteSetupHandoff()"));
  assert.ok(ui.includes("buildSetupCompletionHandoff"));
  assert.ok(ui.includes("applyReadyImportDefaults"));
  assert.ok(ui.includes("setup-import-ready-banner"));
});

test("ACCEPTANCE: completing import produces workspace handoff data and blocks invalid drafts", () => {
  const invalid = setup.createDraft();
  const invalidResult = setup.validateDraft(invalid);
  assert.strictEqual(invalidResult.ok, false);
  assert.ok(invalidResult.errors.riversideLink);
  assert.ok(Object.keys(invalidResult.errors).some((key) => key.indexOf("speaker:") === 0));

  const riversideOnly = setup.createDraft();
  riversideOnly.riversideLink = "https://riverside.fm/studio/probe-path";
  const ready = setup.applyImportContinueDefaults(riversideOnly, { showName: "Probe Show" });
  assert.strictEqual(setup.validateDraft(ready).ok, true);
  const completion = setup.buildSetupCompletionHandoff(setup.summarize(ready), {
    presetSummary: "Studio Spotlight",
  });
  assert.strictEqual(completion.completionEyebrow, "Setup complete");
  assert.strictEqual(completion.handoff.speakers.length, 3);
  assert.ok(completion.handoff.speakers.every((speaker) => speaker.role && speaker.sourceLabel));
  assert.ok(completion.handoff.sourceDetail.includes("riverside.fm"));
  assert.ok(completion.roleSummary.includes("Host"));
});

console.log(`\nimport handoff: ${passed} assertions passed`);
