"use strict";

// Preset-first import setup smoke suite for Podcast Design Canvas (#147).
// Run with: `node tests/import-preset-first.test.js`.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const style = require("../app/episode-style.js");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

const ui = fs.readFileSync(path.join(__dirname, "../app/episode-setup.ui.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../app/styles.css"), "utf8");

test("setup import flow lists episode look before speakers", () => {
  assert.ok(ui.includes("Episode look"));
  assert.ok(ui.includes("Speakers"));
  const flowBlock = ui.slice(ui.indexOf("function renderImportFlowOutline"), ui.indexOf("function renderSpeakerRoleOverview"));
  assert.ok(flowBlock.indexOf("Episode look") < flowBlock.indexOf("Speakers"));
});

test("renderSetup inserts preset section after recording source", () => {
  const setupBlock = ui.slice(ui.indexOf("function renderSetup()"), ui.indexOf("function renderSpeaker("));
  const sourceIdx = setupBlock.indexOf("form.appendChild(sourceCard)");
  const presetIdx = setupBlock.indexOf("renderSetupPresetSection");
  const speakersIdx = setupBlock.indexOf("setup-speakers-card");
  assert.ok(sourceIdx >= 0 && presetIdx > sourceIdx && speakersIdx > presetIdx);
});

test("setup form no longer appends buried template library card", () => {
  assert.ok(ui.includes("function renderSetupPresetSection"));
  assert.ok(!ui.includes("form.appendChild(renderSavedTemplatesCard(saved, null))"));
});

test("speaker cards collapse optional channel and social fields", () => {
  assert.ok(ui.includes("speaker-optional-details"));
  assert.ok(ui.includes("Optional details (channel label & social links)"));
});

test("preset cards reuse episode look previews on the setup screen", () => {
  assert.ok(ui.includes("setup-preset-grid"));
  assert.ok(ui.includes("renderEpisodeLookPreview(look, \"card\")"));
  assert.ok(styles.includes(".setup-preset-grid"));
});

test("ACCEPTANCE: preset selection updates applied style before continue", () => {
  const selection = style.createSelection();
  const next = style.applyPresetToSelection(selection, style.STYLE_PRESETS[1].id, false);
  const summary = style.summarizeStyle(next, 3);
  assert.strictEqual(summary.presetId, style.STYLE_PRESETS[1].id);
  assert.ok(summary.presetName.length > 0);
  const handoffBlock = ui.slice(ui.indexOf("function tryCompleteSetupHandoff"), ui.indexOf("function onContinue()"));
  const presetBlock = ui.slice(ui.indexOf("function renderSetupPresetSection"), ui.indexOf("function renderSetup()"));
  assert.ok(handoffBlock.includes("STY.summarizeStyle(styleSelection, summary.speakerCount)"));
  assert.ok(presetBlock.includes("tryCompleteSetupHandoff({ quiet: true })"));
});

console.log(`\nimport preset-first: ${passed} assertions passed`);
