// Converts a beatmap video the browser cannot play into WebM, using ffmpeg.wasm (FFmpeg compiled to
// WebAssembly, run in a worker). Only the picture is kept, since beatmap videos are muted here, and it
// is scaled to 480 lines high to keep the conversion quick.
//
// The converter is about 30 MB. The browser fetches it from the CDN the first time and keeps it after
// that. Converted videos are kept in IndexedDB, keyed by a hash of the original file, so each video is
// converted once. Conversions run one at a time, since one FFmpeg instance does one job at once.
//
// Every stage reports what it is doing (onStatus), and none can wait forever: a download that stops, a
// converter that does not start, or a conversion that runs far too long fails with a message instead.

import { getVideo, saveVideo } from "./storage.js";

const CDN = "https://cdn.jsdelivr.net/npm";
// Pinned versions. Each is at least two weeks old.
const FFMPEG_VERSION = "0.12.10";   // @ffmpeg/ffmpeg: the JavaScript side and its worker
const CORE_VERSION = "0.12.6";      // @ffmpeg/core: FFmpeg itself, as WebAssembly

const STALL_MS = 30000;             // a download, or the loading of the converter's script, that stops this long has failed
const START_MS = 30000;             // the converter must start within this long
const RUN_MS = 20 * 60 * 1000;      // a conversion that runs longer than this has failed

const mb = (bytes) => (bytes / 1048576).toFixed(0);

function withTimeout(promise, ms, message) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// Fetches a file as a blob URL, reporting the bytes as they arrive. A download that stops for STALL_MS fails.
async function download(url, type, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split("/").pop()}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    let chunk;
    try {
      chunk = await withTimeout(reader.read(), STALL_MS, "the download stopped");
    } catch (err) {
      reader.cancel().catch(() => {});
      throw err;
    }
    if (chunk.done) break;
    parts.push(chunk.value);
    got += chunk.value.length;
    onBytes?.(got, total);
  }
  return URL.createObjectURL(new Blob(parts, { type }));
}

let converter = null;               // the loaded FFmpeg
let converterLoading = null;        // the load in progress, so two videos share one load

// Loads the converter once. A failed load is cleared, so the next video tries again.
function loadConverter(onStatus) {
  if (converter) return Promise.resolve(converter);
  if (!converterLoading) {
    converterLoading = (async () => {
      const base = `${CDN}/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm`;
      const core = `${CDN}/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
      try {
        onStatus("downloading the video converter");
        const { FFmpeg } = await withTimeout(import(`${base}/index.js`), STALL_MS,
          "the converter's script did not download");
        const classWorkerURL = await download(`${base}/worker.js`, "text/javascript");
        const coreURL = await download(`${core}/ffmpeg-core.js`, "text/javascript");
        const wasmURL = await download(`${core}/ffmpeg-core.wasm`, "application/wasm", (got, total) => {
          onStatus(total
            ? `downloading the video converter, ${mb(got)} of ${mb(total)} MB`
            : `downloading the video converter, ${mb(got)} MB`);
        });
        const ff = new FFmpeg();
        onStatus("starting the video converter");
        await withTimeout(ff.load({ classWorkerURL, coreURL, wasmURL }), START_MS,
          "the converter did not start");
        converter = ff;
        return ff;
      } catch (err) {
        converterLoading = null;
        throw new Error(`the converter could not be loaded: ${err.message}`);
      }
    })();
  }
  return converterLoading;
}

// Runs one conversion. Returns the WebM bytes.
async function convert(bytes, ext, onStatus) {
  const ff = await loadConverter(onStatus);
  const input = `input.${ext}`;
  const started = Date.now();
  let pct = null;
  const progress = ({ progress: p }) => {
    pct = Math.round(Math.min(1, Math.max(0, p)) * 100);
    onStatus(`converting, ${pct}%`);
  };
  // Some files give no progress; show the time so far, so the page is seen to be working.
  const tick = setInterval(() => {
    if (pct === null) onStatus(`converting, ${Math.round((Date.now() - started) / 1000)} s so far`);
  }, 1000);
  ff.on("progress", progress);
  try {
    await ff.writeFile(input, new Uint8Array(bytes));
    onStatus("converting");
    const code = await withTimeout(ff.exec([
      "-i", input,
      "-an",                         // no sound: the video is muted
      "-vf", "scale=-2:480",         // 480 lines high, keeping the shape
      "-c:v", "libvpx", "-b:v", "1M",
      "-deadline", "realtime", "-cpu-used", "8",
      "out.webm",
    ]), RUN_MS, "the conversion took too long");
    if (code !== 0) throw new Error(`ffmpeg could not read the video (code ${code})`);
    return await ff.readFile("out.webm");
  } catch (err) {
    if (converter === ff && /took too long/.test(err.message)) {
      converter = null;              // a stuck converter is stopped, and the next video starts a fresh one
      ff.terminate?.();
    }
    throw err;
  } finally {
    clearInterval(tick);
    ff.off?.("progress", progress);
    await ff.deleteFile(input).catch(() => {});
    await ff.deleteFile("out.webm").catch(() => {});
  }
}

// A name for the video in the cache: its SHA-256. Null when the page cannot hash (SubtleCrypto needs a
// secure page), in which case the video is converted every time.
async function cacheKey(bytes) {
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") + ".webm";
  } catch (_) {
    return null;
  }
}

let queue = Promise.resolve();      // conversions go in order
let pending = 0;                    // conversions queued or running

// The WebM copy of a video the browser cannot play, as a Blob: from the cache, or converted now.
// onStatus(text) reports what is happening. isCurrent() says whether the player still wants the video; a
// conversion that has not started yet is skipped when it does not, and resolves to null.
export async function webmFor(bytes, ext, { onStatus = () => {}, isCurrent = () => true } = {}) {
  const key = await cacheKey(bytes);
  if (key) {
    const cached = await getVideo(key);
    if (cached) return cached.blob;
  }
  pending++;
  if (pending > 1) onStatus("waiting for an earlier conversion to finish");
  const job = queue.then(async () => {
    try {
      if (!isCurrent()) return null;
      const out = await convert(bytes, ext, onStatus);
      const blob = new Blob([out], { type: "video/webm" });
      if (key) saveVideo({ name: key, blob });     // best effort: a full database just means no cache
      return blob;
    } finally {
      pending--;
    }
  });
  queue = job.catch(() => {});
  return job;
}
