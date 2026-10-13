// Browser storage for imported beatmaps and skins. Both are kept as { name, blob } records in
// IndexedDB, one object store each, so they survive a reload or a closed tab and the original
// files are not needed again. Every call is best effort: IndexedDB can be blocked (some private
// windows, site data turned off) or full. The player still works without it; the saved list is
// just empty.

const DB_NAME = "osuport";
// 1 had only the skins store, 2 added maps, 3 added an assets store that is no longer used, and 4
// added videos (converted copies of beatmap videos, see transcode.js). The unused assets store is kept
// so the database never goes down a version.
const DB_VERSION = 4;
const STORES = { skins: "skins", maps: "maps", videos: "videos" };
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const store of Object.values(STORES)) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: "name" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // A newer version of this page needs to upgrade the database: let go of it, reopen later.
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; });   // a failed open is retried on the next call
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function get(store, name) {
  try {
    return (await run(store, "readonly", (s) => s.get(name))) || null;
  } catch (_) {
    return null;
  }
}

async function list(store) {
  try {
    return (await run(store, "readonly", (s) => s.getAll())) || [];
  } catch (_) {
    return [];
  }
}

// Returns false when the record could not be stored (the caller can say so).
async function put(store, rec) {
  // Asks the browser not to clear this data under storage pressure. Best effort: some browsers
  // answer no, and that is not an error.
  try { navigator.storage?.persist?.()?.catch?.(() => {}); } catch (_) { /* not supported */ }
  try {
    await run(store, "readwrite", (s) => s.put(rec));
    return true;
  } catch (_) {
    return false;
  }
}

async function remove(store, name) {
  try {
    await run(store, "readwrite", (s) => s.delete(name));
  } catch (_) {
    // storage is best effort
  }
}

export const listSkins = () => list(STORES.skins);
export const saveSkin = (rec) => put(STORES.skins, rec);       // rec: { name, blob }
export const deleteSkin = (name) => remove(STORES.skins, name);
export const listMaps = () => list(STORES.maps);
export const saveMap = (rec) => put(STORES.maps, rec);          // rec: { name, blob }
export const deleteMap = (name) => remove(STORES.maps, name);
export const getVideo = (name) => get(STORES.videos, name);     // returns { name, blob } or null
export const saveVideo = (rec) => put(STORES.videos, rec);      // rec: { name, blob }
