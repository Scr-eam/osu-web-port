// Game assets from osu-resources (Attribution-NonCommercial 4.0), listed in assets/manifest.json.
// Each file is looked up in this order: the browser's saved copy (IndexedDB), a local copy in
// assets/osu-resources/ (made by tools/fetch_assets.py), then GitHub at the commit the manifest
// names. Anything downloaded is saved in the browser, so the next visit needs no download.
import { getAsset, saveAsset } from "./storage.js";

const CONCURRENCY = 6;
const ARGON_DIGITS = /Textures\/Gameplay\/Fonts\/argon-counter-(.+)\.png$/;
const HIT_NORMAL = "Samples/Gameplay/Argon/normal-hitnormal.wav";

async function tryFetch(url) {
  try {
    const res = await fetch(url);
    return res.ok ? await res.blob() : null;
  } catch (_) {
    return null;
  }
}

async function fetchOne(manifest, path) {
  const saved = await getAsset(path);
  if (saved) return { blob: saved, from: "browser" };
  const local = await tryFetch(`./assets/osu-resources/${path}`);
  if (local) {
    await saveAsset(path, local);
    return { blob: local, from: "local" };
  }
  const remote = await tryFetch(manifest.base + path);
  if (remote) {
    await saveAsset(path, remote);
    return { blob: remote, from: "download" };
  }
  return { blob: null, from: "missing" };
}

// Resolves to { blobs: Map(path -> Blob), from: { browser, local, download, missing } }.
export async function loadAssetBlobs(onProgress = () => {}) {
  const manifest = await (await fetch("./assets/manifest.json")).json();
  const blobs = new Map();
  const from = { browser: 0, local: 0, download: 0, missing: 0 };
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < manifest.files.length) {
      const path = manifest.files[next++];
      const got = await fetchOne(manifest, path);
      from[got.from]++;
      if (got.blob) blobs.set(path, got.blob);
      onProgress(++done, manifest.files.length);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { blobs, from };
}

// The default skin, in the shape loadSkinFile returns: Argon's score digits, and its normal hit sound.
// Missing files just leave a piece out, and the game draws that piece flat.
export async function buildDefaultSkin(blobs, audioCtx) {
  const images = new Map();
  for (const [path, blob] of blobs) {
    const m = ARGON_DIGITS.exec(path);
    if (!m) continue;
    const glyph = { percentage: "percent" }[m[1]] || m[1];       // digits, dot, x
    images.set(`score-${glyph}`, await createImageBitmap(blob));
  }
  let hit = null;
  const hitBlob = blobs.get(HIT_NORMAL);
  if (hitBlob && audioCtx) {
    try {
      hit = await audioCtx.decodeAudioData(await hitBlob.arrayBuffer());
    } catch (_) {
      hit = null;
    }
  }
  if (images.size === 0 && !hit) return null;
  return {
    ini: { hitOverlap: 0, scoreOverlap: 0, overlayAboveNumber: false },
    colours: [],
    images,
    scales: new Map(),
    blank: new Set(),
    hit,
  };
}
