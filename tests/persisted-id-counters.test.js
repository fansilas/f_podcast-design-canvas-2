"use strict";

// Persisted show, episode, and template ID counters survive reload (#163).
// Run with: `node tests/persisted-id-counters.test.js`.

const assert = require("assert");
const library = require("../app/show-library.js");
const templates = require("../app/show-templates.js");
const gallery = require("../app/creator-template-gallery.js");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

function minimalCanvas(title) {
  return {
    presetId: "clean-studio",
    presetName: "Clean Studio",
    layoutId: "grid",
    pacingId: "balanced",
    background: "#10131f",
    accent: "#6c4cff",
    titleText: title || "Sample layout",
    layers: [],
    speakerFrames: [],
  };
}

function simulateReload() {
  library._resetCounters();
  templates._resetTemplateCounter();
  gallery._resetListingCounter();
}

test("deserializeLibrary restores show and episode ID counters", () => {
  simulateReload();
  let lib = library.createLibrary();
  const showA = library.createShow("Founders Unfiltered");
  lib = library.addShow(lib, showA);
  const epA = library.createEpisode(showA.id, "Episode 1");
  lib = library.addEpisode(lib, showA.id, epA);
  const showB = library.createShow("Weeknight Live");
  lib = library.addShow(lib, showB);

  assert.strictEqual(showA.id, "show-1");
  assert.strictEqual(epA.id, "ep-1");
  assert.strictEqual(showB.id, "show-2");

  lib = library.deserializeLibrary(library.serializeLibrary(lib));

  const showC = library.createShow("Studio Notes");
  assert.strictEqual(showC.id, "show-3");
  lib = library.addShow(lib, showC);

  const epB = library.createEpisode(showA.id, "Episode 2");
  assert.strictEqual(epB.id, "ep-2");
  lib = library.addEpisode(lib, showA.id, epB);

  const ids = lib.shows.flatMap((show) => [show.id].concat((show.episodes || []).map((ep) => ep.id)));
  assert.strictEqual(new Set(ids).size, ids.length, "reloaded library keeps unique IDs");
  assert.ok(ids.includes("show-1") && ids.includes("show-2") && ids.includes("show-3"));
  assert.ok(ids.includes("ep-1") && ids.includes("ep-2"));
});

test("deserializeStore restores template ID counters", () => {
  simulateReload();
  let store = templates.createStore();
  const tplA = templates.createTemplate("Agency Split", minimalCanvas("Agency Split"));
  store = templates.saveTemplate(store, tplA);
  const tplB = templates.createTemplate("Panel Talk", minimalCanvas("Panel Talk"));
  store = templates.saveTemplate(store, tplB);

  assert.strictEqual(tplA.id, "tpl-1");
  assert.strictEqual(tplB.id, "tpl-2");

  store = templates.deserializeStore(templates.serializeStore(store));

  const tplC = templates.createTemplate("Founders Format", minimalCanvas("Founders Format"));
  assert.strictEqual(tplC.id, "tpl-3");
  store = templates.saveTemplate(store, tplC);

  assert.strictEqual(templates.listTemplates(store).length, 3);
  assert.ok(templates.getTemplate(store, "tpl-1"));
  assert.ok(templates.getTemplate(store, "tpl-2"));
  assert.ok(templates.getTemplate(store, "tpl-3"));
  assert.strictEqual(templates.getTemplate(store, "tpl-1").name, "Agency Split");
});

test("ACCEPTANCE: create items before reload, then new items stay unique after reload", () => {
  simulateReload();

  let lib = library.createLibrary();
  const show = library.createShow("Creator Show");
  lib = library.addShow(lib, show);
  const ep = library.createEpisode(show.id, "Pilot");
  lib = library.addEpisode(lib, show.id, ep);

  let templateStore = templates.createStore();
  const template = templates.createTemplate("Saved Look", minimalCanvas("Saved Look"));
  templateStore = templates.saveTemplate(templateStore, template);

  let galleryStore = gallery.createGallery();
  galleryStore = gallery.publishListing(galleryStore, template, {
    name: "Shared Layout",
    description: "Gallery listing for reuse",
  });

  const beforeReload = {
    showId: show.id,
    episodeId: ep.id,
    templateId: template.id,
    listingId: gallery.listListings(galleryStore)[0].id,
  };

  simulateReload();

  lib = library.deserializeLibrary(library.serializeLibrary(lib));
  templateStore = templates.deserializeStore(templates.serializeStore(templateStore));
  galleryStore = gallery.deserializeGallery(gallery.serializeGallery(galleryStore));

  const nextShow = library.createShow("Second Show");
  lib = library.addShow(lib, nextShow);
  const nextEp = library.createEpisode(show.id, "Episode Two");
  lib = library.addEpisode(lib, show.id, nextEp);
  const nextTemplate = templates.createTemplate("Another Look", minimalCanvas("Another Look"));
  templateStore = templates.saveTemplate(templateStore, nextTemplate);
  galleryStore = gallery.publishListing(galleryStore, nextTemplate, {
    name: "Second Listing",
    description: "Published after reload",
  });

  assert.notStrictEqual(nextShow.id, beforeReload.showId);
  assert.notStrictEqual(nextEp.id, beforeReload.episodeId);
  assert.notStrictEqual(nextTemplate.id, beforeReload.templateId);

  const newListing = gallery.listListings(galleryStore).find((item) => item.name === "Second Listing");
  assert.ok(newListing, "second gallery listing saved after reload");
  assert.notStrictEqual(newListing.id, beforeReload.listingId);

  assert.strictEqual(nextShow.id, "show-2");
  assert.strictEqual(nextEp.id, "ep-2");
  assert.strictEqual(nextTemplate.id, "tpl-2");
  assert.strictEqual(newListing.id, "gal-2");

  assert.ok(library.getShow(lib, beforeReload.showId));
  assert.ok(templates.getTemplate(templateStore, beforeReload.templateId));
  assert.strictEqual(
    library.listEpisodes(lib, beforeReload.showId).length,
    2,
    "new episode appends without replacing the saved pilot",
  );
});

console.log(`\npersisted id counters: ${passed} test(s) passed.`);
