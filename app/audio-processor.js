"use strict";

// Real audio processing engine for Podcast Design Canvas (#197).
//
// Decodes an imported speaker track (16-bit PCM WAV), applies genuine per-sample
// DSP for the creator's chosen polish settings, and re-encodes a NEW polished WAV.
// This is a real input->output transformation of the imported bytes — not a
// synthesized stand-in — so review/export consume durable treated audio.
//
// DOM-free and environment-agnostic (ArrayBuffer / typed array / Node Buffer), so
// the browser polish step and the node tests share one source of truth.
(function (global) {
  // ---- byte helpers (work in browser + node) --------------------------------
  function toUint8(bytes) {
    if (bytes instanceof Uint8Array) {
      return bytes;
    }
    if (bytes instanceof ArrayBuffer) {
      return new Uint8Array(bytes);
    }
    if (bytes && ArrayBuffer.isView(bytes)) {
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    throw new TypeError("audio-processor: expected ArrayBuffer or typed array of WAV bytes");
  }

  function viewOf(u8) {
    return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }

  function readTag(u8, offset) {
    return String.fromCharCode(u8[offset], u8[offset + 1], u8[offset + 2], u8[offset + 3]);
  }

  // ---- WAV decode (16-bit PCM, mono or stereo) ------------------------------
  function decodeWav(bytes) {
    const u8 = toUint8(bytes);
    const view = viewOf(u8);
    if (u8.byteLength < 44 || readTag(u8, 0) !== "RIFF" || readTag(u8, 8) !== "WAVE") {
      throw new Error("audio-processor: not a RIFF/WAVE file");
    }

    let offset = 12;
    let fmt = null;
    let dataOffset = -1;
    let dataLength = 0;
    while (offset + 8 <= u8.byteLength) {
      const tag = readTag(u8, offset);
      const size = view.getUint32(offset + 4, true);
      const body = offset + 8;
      if (tag === "fmt ") {
        fmt = {
          audioFormat: view.getUint16(body, true),
          numChannels: view.getUint16(body + 2, true),
          sampleRate: view.getUint32(body + 4, true),
          bitsPerSample: view.getUint16(body + 14, true),
        };
      } else if (tag === "data") {
        dataOffset = body;
        dataLength = Math.min(size, u8.byteLength - body);
      }
      // chunks are word-aligned
      offset = body + size + (size % 2);
    }

    if (!fmt || dataOffset < 0) {
      throw new Error("audio-processor: missing fmt or data chunk");
    }
    if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
      throw new Error("audio-processor: only 16-bit PCM WAV is supported");
    }

    const channels = Math.max(1, fmt.numChannels);
    const frameCount = Math.floor(dataLength / 2 / channels);
    const data = [];
    for (let c = 0; c < channels; c += 1) {
      data.push(new Float32Array(frameCount));
    }
    for (let i = 0; i < frameCount; i += 1) {
      for (let c = 0; c < channels; c += 1) {
        const sample = view.getInt16(dataOffset + (i * channels + c) * 2, true);
        data[c][i] = sample / 32768;
      }
    }
    return {
      sampleRate: fmt.sampleRate || 44100,
      channels: channels,
      frameCount: frameCount,
      data: data,
    };
  }

  // ---- WAV encode (16-bit PCM) ----------------------------------------------
  function encodeWav(decoded) {
    const channels = Math.max(1, decoded.channels || decoded.data.length);
    const frameCount = decoded.frameCount != null ? decoded.frameCount : decoded.data[0].length;
    const sampleRate = decoded.sampleRate || 44100;
    const blockAlign = channels * 2;
    const dataLength = frameCount * blockAlign;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    function writeTag(offset, tag) {
      for (let i = 0; i < 4; i += 1) {
        view.setUint8(offset + i, tag.charCodeAt(i));
      }
    }

    writeTag(0, "RIFF");
    view.setUint32(4, 36 + dataLength, true);
    writeTag(8, "WAVE");
    writeTag(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeTag(36, "data");
    view.setUint32(40, dataLength, true);

    let pos = 44;
    for (let i = 0; i < frameCount; i += 1) {
      for (let c = 0; c < channels; c += 1) {
        let s = decoded.data[c][i];
        if (s > 1) s = 1;
        else if (s < -1) s = -1;
        view.setInt16(pos, Math.round(s * 32767), true);
        pos += 2;
      }
    }
    return buffer;
  }

  // ---- DSP -------------------------------------------------------------------
  // Each control maps light/balanced/strong to a real coefficient so the chosen
  // quality produces a measurably different waveform.
  const STRENGTH = { light: 0.34, balanced: 0.62, strong: 0.9 };

  function strength(level) {
    return STRENGTH[level] != null ? STRENGTH[level] : STRENGTH.balanced;
  }

  function rms(channel) {
    if (!channel.length) return 0;
    let sum = 0;
    for (let i = 0; i < channel.length; i += 1) {
      sum += channel[i] * channel[i];
    }
    return Math.sqrt(sum / channel.length);
  }

  function peak(channel) {
    let max = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const a = Math.abs(channel[i]);
      if (a > max) max = a;
    }
    return max;
  }

  function frameRms(channels) {
    let sum = 0;
    let n = 0;
    channels.forEach((ch) => {
      for (let i = 0; i < ch.length; i += 1) {
        sum += ch[i] * ch[i];
        n += 1;
      }
    });
    return n ? Math.sqrt(sum / n) : 0;
  }

  function framePeak(channels) {
    let max = 0;
    channels.forEach((ch) => {
      const p = peak(ch);
      if (p > max) max = p;
    });
    return max;
  }

  // High-pass + noise gate: strips low-end rumble and silences hiss below a floor.
  function noiseClean(channel, level) {
    const k = strength(level);
    const floor = 0.006 + 0.02 * k; // amplitude gate threshold
    const hp = 0.85 + 0.13 * k; // 1st-order high-pass coefficient
    let prevIn = 0;
    let prevOut = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const x = channel[i];
      let y = hp * (prevOut + x - prevIn);
      prevIn = x;
      prevOut = y;
      const a = Math.abs(y);
      if (a < floor) {
        y *= a / floor; // soft gate, not a hard cut
      }
      channel[i] = y;
    }
  }

  // Voice leveling: normalize channel RMS toward a target loudness.
  function level(channel, levelId) {
    const k = strength(levelId);
    const target = 0.16 + 0.06 * k;
    const current = rms(channel);
    if (current < 1e-5) return;
    let gain = target / current;
    const maxGain = 1 + 2.5 * k;
    if (gain > maxGain) gain = maxGain;
    // blend toward unity by strength so "light" stays gentle
    gain = 1 + (gain - 1) * k;
    for (let i = 0; i < channel.length; i += 1) {
      channel[i] *= gain;
    }
  }

  // Speech clarity: presence lift via first-difference high-shelf.
  function clarify(channel, levelId) {
    const k = 0.55 * strength(levelId);
    let prev = channel.length ? channel[0] : 0;
    for (let i = 0; i < channel.length; i += 1) {
      const x = channel[i];
      channel[i] = x + k * (x - prev);
      prev = x;
    }
  }

  // Overall enhancement: gentle soft-saturation warmth + makeup.
  function enhance(channel, levelId) {
    const k = strength(levelId);
    const drive = 1 + 1.6 * k;
    const makeup = 1 + 0.12 * k;
    for (let i = 0; i < channel.length; i += 1) {
      const x = channel[i] * drive;
      channel[i] = (Math.tanh(x) / Math.tanh(drive)) * makeup;
    }
  }

  function applyPolish(decoded, settings) {
    const opts = settings || {};
    const out = {
      sampleRate: decoded.sampleRate,
      channels: decoded.channels,
      frameCount: decoded.frameCount,
      data: decoded.data.map((ch) => Float32Array.from(ch)),
    };
    out.data.forEach((channel) => {
      if (opts.noiseCleanup) noiseClean(channel, opts.noiseCleanup);
      if (opts.leveling) level(channel, opts.leveling);
      if (opts.speechClarity) clarify(channel, opts.speechClarity);
      if (opts.enhancement) enhance(channel, opts.enhancement);
    });
    return out;
  }

  // ---- fingerprint (deterministic FNV-1a over bytes) ------------------------
  function fingerprint(bytes) {
    const u8 = toUint8(bytes);
    let hash = 0x811c9dc5;
    for (let i = 0; i < u8.length; i += 1) {
      hash ^= u8[i];
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return ("0000000" + hash.toString(16)).slice(-8);
  }

  function roundTo(value, places) {
    const f = Math.pow(10, places);
    return Math.round(value * f) / f;
  }

  function dbFromRatio(after, before) {
    if (before < 1e-6 || after < 1e-6) return 0;
    return roundTo(20 * Math.log10(after / before), 1);
  }

  // ---- top-level: process one imported track --------------------------------
  // Returns the polished WAV bytes plus metrics that PROVE the transformation
  // (RMS/peak deltas) and bind the output to its specific source (fingerprint).
  // Transform an already-decoded PCM track (so the browser can decode real upload
  // formats — mp4/aac/webm — via AudioContext and still share this DSP + encode +
  // metrics path with the node-tested WAV pipeline). sourceBytes is the original
  // imported bytes, used only to bind the output to its source by fingerprint.
  function processDecoded(decoded, sourceBytes, settings) {
    const src = toUint8(sourceBytes);
    const inputRms = frameRms(decoded.data);
    const inputPeak = framePeak(decoded.data);

    const polished = applyPolish(decoded, settings);
    const outputBuffer = encodeWav(polished);
    const outputBytes = new Uint8Array(outputBuffer);
    const outputRms = frameRms(polished.data);
    const outputPeak = framePeak(polished.data);

    const durationMs = decoded.sampleRate
      ? Math.round((decoded.frameCount / decoded.sampleRate) * 1000)
      : 0;

    return {
      outputBytes: outputBytes,
      buffer: outputBuffer,
      metrics: {
        sampleRate: decoded.sampleRate,
        channels: decoded.channels,
        frameCount: decoded.frameCount,
        durationMs: durationMs,
        inputBytes: src.byteLength,
        outputBytes: outputBytes.byteLength,
        inputRms: roundTo(inputRms, 4),
        outputRms: roundTo(outputRms, 4),
        inputPeak: roundTo(inputPeak, 4),
        outputPeak: roundTo(outputPeak, 4),
        rmsDeltaDb: dbFromRatio(outputRms, inputRms),
        sourceFingerprint: fingerprint(src),
        outputFingerprint: fingerprint(outputBytes),
      },
    };
  }

  function processTrack(inputBytes, settings) {
    const sourceBytes = toUint8(inputBytes);
    const decoded = decodeWav(sourceBytes);
    return processDecoded(decoded, sourceBytes, settings);
  }

  const api = {
    decodeWav,
    encodeWav,
    applyPolish,
    fingerprint,
    processDecoded,
    processTrack,
    rms,
    peak,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }

  global.PdcAudioProcessor = api;
}(typeof window !== "undefined" ? window : globalThis));
