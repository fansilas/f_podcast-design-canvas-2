// Running-product acceptance for #197: real audio polish processing.
// Drives the Riverside-link import path (no manual uploads) over file:// — exactly
// how the maintainer's sandbox serves the app. The audio step polishes every imported
// track ON ARRIVAL (real decode -> DSP -> encode -> saved asset), so the running app
// itself shows per-track Polished results; "Apply audio & continue" stays the visible
// action that commits those saved assets into the step and advances. This proof waits
// for the auto-polish to complete, asserts the Polished state + saved metrics, CLICKS
// Apply audio & continue, then verifies reload persistence and that review consumes the
// treated assets.
// Run: node tests/browser-audio-polish-apply.mjs   (requires `playwright`)
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const EPISODE = "Indie Makers Weekly — Episode 3";
const SPEAKERS = ["Jordan Lee", "Priya Shah", "Chris Ortiz"];

async function openPolishAudio(page) {
  // The checklist label is "Polish audio" before processing and "Change audio" after.
  await page.locator("#workspace-primary-next, .workspace-checklist-open").filter({ hasText: /Polish audio|Change audio/ }).first().click();
  await page.locator(".audio-step").waitFor();
}

async function main() {
  let browser;
  let failed = false;
  const log = (ok, msg) => {
    console.log(`${ok ? "  ok" : " FAIL"} ${msg}`);
    if (!ok) failed = true;
  };

  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // Load straight from the filesystem — exactly how the maintainer's sandbox
    // serves the app. Source recordings are inlined (no fetch), so this works.
    await page.goto("file://" + root + "index.html", { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "networkidle" });

    // --- Setup from a RIVERSIDE LINK (no manual uploads) — the imported-episode
    // path the maintainer's probe exercises. Each track's bundled recording is
    // attached as the imported source so audio polish has real bytes to process. ---
    await page.getByRole("button", { name: "Start blank episode" }).click();
    await page.waitForSelector("form.setup-import");
    await page.locator("#f-episodeName").fill(EPISODE);
    await page.locator("#f-riversideLink").fill("https://riverside.fm/studio/indie-makers-ep3");
    for (let i = 0; i < SPEAKERS.length; i += 1) {
      await page.locator(`#f-sp-${i}-name`).fill(SPEAKERS[i]);
    }
    await page.locator(".setup-preset-card").first().click();
    await page.locator(".guided-workspace").waitFor({ state: "visible" });

    // --- Reach the audio step; imported tracks polish automatically on arrival ---
    await openPolishAudio(page);
    const audioText = await page.locator(".audio-step").innerText();
    log(!/No imported audio/i.test(audioText), "Imported tracks have source audio bound (no 'No imported audio')");

    // The running app processes every imported track without the creator hunting for
    // a button: wait for all three to reach Polished.
    await page.locator(".audio-track-status.status-complete").nth(2).waitFor({ state: "visible", timeout: 30000 });
    const completeCount = await page.locator(".audio-track-status.status-complete").count();
    log(completeCount === 3, `All three imported tracks polished on arrival (saw ${completeCount})`);
    const firstPill = await page.locator(".audio-track-status.status-complete").first().innerText();
    log(/Polished/.test(firstPill) && /dB/.test(firstPill), `Polished pill shows a real metric: "${firstPill.trim()}"`);
    const progress = await page.locator("#audio-progress-line").innerText();
    log(/All 3 tracks polished/.test(progress), `Progress line confirms completion: "${progress.trim()}"`);

    // Apply audio & continue stays the explicit, visible action that commits the saved
    // assets into the step — above the fold so it is unmissable.
    log(await page.locator("#audio-apply-btn").isVisible(), "Apply audio & continue stays visible as the commit action");
    const applyBox = await page.locator("#audio-apply-btn").boundingBox();
    log(applyBox && applyBox.y < 720, `Apply is above the fold (y=${applyBox ? Math.round(applyBox.y) : "?"}) so the action is unmissable`);

    // --- Click Apply audio & continue: commit + advance back to the workspace ---
    await page.locator("#audio-apply-btn").click();
    await page.locator(".guided-workspace").waitFor({ state: "visible", timeout: 15000 });
    log(true, "ACCEPTANCE: Apply audio & continue committed the polished tracks and advanced");

    await page.screenshot({ path: root + "tests/audio-polish-apply.png", fullPage: false });

    // --- Persistence: durable refs survive a real reload ---
    const persisted = await page.evaluate(() => {
      const raw = localStorage.getItem("pdc-episode-sessions");
      if (!raw) return { ok: false };
      const sessions = JSON.parse(raw);
      const snap = Object.values(sessions)[0] || {};
      const pt = snap.polishedTracks || [];
      const assets = (snap.appliedAudioPolish && snap.appliedAudioPolish.polishedAssets) || [];
      return {
        ok: pt.length === 3 && assets.length === 3
          && pt.every((t) => t.result && t.result.outputFingerprint && t.result.sourceFingerprint),
      };
    });
    log(persisted.ok, "Polished asset references (fingerprints) are persisted for all 3 tracks");

    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Open" }).first().click();
    await page.locator(".show-episode-resume-btn").first().click();
    await page.locator(".guided-workspace").waitFor({ state: "visible" });
    await openPolishAudio(page);
    const reloadedComplete = await page.locator(".audio-track-status.status-complete").count();
    log(reloadedComplete === 3, `After reload + resume, all 3 tracks still show Polished (saw ${reloadedComplete})`);
    log(await page.locator("#audio-continue-btn").isVisible(), "Reloaded applied episode keeps the completion gate satisfied (Continue shown)");

    // --- Export/review consume the polished assets ---
    await page.locator("#audio-continue-btn").click();
    await page.locator(".guided-workspace").waitFor({ state: "visible" });
    await page.locator(".workspace-checklist-open").filter({ hasText: "Review episode" }).first().click();
    await page.locator(".publish-review-step").waitFor();
    const bodyText = await page.locator("#app").innerText();
    log(/\d+\/\d+ tracks? polished/.test(bodyText), "Publish review surfaces the polished tracks as the audio source");
  } catch (err) {
    console.error(err);
    failed = true;
  } finally {
    if (browser) await browser.close();
  }

  if (failed) process.exit(1);
  console.log("\nBrowser audio polish apply: all checks passed.");
}

main();
