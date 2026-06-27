"use strict";

// Durable per-track audio asset store for Podcast Design Canvas (#197).
//
// Holds the real imported source bytes and the polished output bytes for each
// speaker track, keyed by episode + track index. Browser uses IndexedDB so a
// full-length episode's WAV data never goes through localStorage (which would
// blow its quota); node/tests use an in-memory map. Every track is stored under
// its own key, so saving track 3 never clobbers tracks 1-2 (the last-write-wins
// reload bug that closed earlier attempts).
//
// All methods are async (Promise-returning) so the IndexedDB and in-memory
// backends share one interface.
(function (global) {
  const DB_NAME = "pdc-audio";
  const DB_VERSION = 1;
  const SOURCE_STORE = "source";
  const POLISHED_STORE = "polished";

  function hasIndexedDb() {
    try {
      return typeof indexedDB !== "undefined" && indexedDB !== null;
    } catch (err) {
      return false;
    }
  }

  function trackKey(episodeKey, trackIndex) {
    return `${episodeKey}::${trackIndex}`;
  }

  // ---- in-memory backend (node, tests, and browsers without IndexedDB) ------
  function memoryBackend() {
    const source = new Map();
    const polished = new Map();
    const storeFor = (name) => (name === POLISHED_STORE ? polished : source);
    return {
      put(storeName, key, value) {
        storeFor(storeName).set(key, value);
        return Promise.resolve(value);
      },
      get(storeName, key) {
        return Promise.resolve(storeFor(storeName).get(key) || null);
      },
      list(storeName, episodeKey) {
        const prefix = `${episodeKey}::`;
        const out = [];
        storeFor(storeName).forEach((value, key) => {
          if (key.indexOf(prefix) === 0) out.push(value);
        });
        return Promise.resolve(out);
      },
      remove(episodeKey) {
        const prefix = `${episodeKey}::`;
        [source, polished].forEach((map) => {
          Array.from(map.keys()).forEach((key) => {
            if (key.indexOf(prefix) === 0) map.delete(key);
          });
        });
        return Promise.resolve();
      },
    };
  }

  // ---- IndexedDB backend -----------------------------------------------------
  function idbBackend() {
    let dbPromise = null;
    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(SOURCE_STORE)) db.createObjectStore(SOURCE_STORE);
          if (!db.objectStoreNames.contains(POLISHED_STORE)) db.createObjectStore(POLISHED_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbPromise;
    }
    function tx(storeName, mode, run) {
      return open().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        const result = run(store);
        t.oncomplete = () => resolve(result.value);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }));
    }
    return {
      put(storeName, key, value) {
        return tx(storeName, "readwrite", (store) => {
          store.put(value, key);
          return { value: value };
        });
      },
      get(storeName, key) {
        return tx(storeName, "readonly", (store) => {
          const holder = { value: null };
          const req = store.get(key);
          req.onsuccess = () => { holder.value = req.result || null; };
          return holder;
        });
      },
      list(storeName, episodeKey) {
        const prefix = `${episodeKey}::`;
        return tx(storeName, "readonly", (store) => {
          const holder = { value: [] };
          const req = store.openCursor();
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return;
            if (String(cursor.key).indexOf(prefix) === 0) holder.value.push(cursor.value);
            cursor.continue();
          };
          return holder;
        });
      },
      remove(episodeKey) {
        const prefix = `${episodeKey}::`;
        return open().then((db) => new Promise((resolve, reject) => {
          const t = db.transaction([SOURCE_STORE, POLISHED_STORE], "readwrite");
          [SOURCE_STORE, POLISHED_STORE].forEach((name) => {
            const req = t.objectStore(name).openCursor();
            req.onsuccess = () => {
              const cursor = req.result;
              if (!cursor) return;
              if (String(cursor.key).indexOf(prefix) === 0) cursor.delete();
              cursor.continue();
            };
          });
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
        }));
      },
    };
  }

  let backend = null;
  function getBackend() {
    if (backend) return backend;
    backend = hasIndexedDb() ? idbBackend() : memoryBackend();
    return backend;
  }

  // Normalize bytes to a transferable form the backend can store (Uint8Array).
  function toBytes(value) {
    if (value == null) return null;
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  }

  function putSource(episodeKey, trackIndex, record) {
    const bytes = toBytes(record && record.bytes);
    const value = Object.assign({}, record, {
      episodeKey: episodeKey,
      trackIndex: trackIndex,
      bytes: bytes,
      byteLength: bytes ? bytes.byteLength : 0,
    });
    return getBackend().put(SOURCE_STORE, trackKey(episodeKey, trackIndex), value);
  }

  function getSource(episodeKey, trackIndex) {
    return getBackend().get(SOURCE_STORE, trackKey(episodeKey, trackIndex));
  }

  function putPolished(episodeKey, trackIndex, record) {
    const bytes = toBytes(record && record.bytes);
    const value = Object.assign({}, record, {
      episodeKey: episodeKey,
      trackIndex: trackIndex,
      bytes: bytes,
      byteLength: bytes ? bytes.byteLength : 0,
    });
    return getBackend().put(POLISHED_STORE, trackKey(episodeKey, trackIndex), value);
  }

  function getPolished(episodeKey, trackIndex) {
    return getBackend().get(POLISHED_STORE, trackKey(episodeKey, trackIndex));
  }

  function listPolished(episodeKey) {
    return getBackend().list(POLISHED_STORE, episodeKey).then((rows) =>
      rows.slice().sort((a, b) => (a.trackIndex || 0) - (b.trackIndex || 0)),
    );
  }

  function clearEpisode(episodeKey) {
    return getBackend().remove(episodeKey);
  }

  // For tests: force the in-memory backend regardless of environment.
  function _useMemoryBackend() {
    backend = memoryBackend();
    return backend;
  }

  const api = {
    putSource,
    getSource,
    putPolished,
    getPolished,
    listPolished,
    clearEpisode,
    trackKey,
    _useMemoryBackend,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }

  global.PdcAudioAssets = api;
}(typeof window !== "undefined" ? window : globalThis));
