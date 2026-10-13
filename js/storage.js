// Persistência local: localStorage para dados, IndexedDB para as imagens dos recibos.

export const KEYS = {
  people: "sr.people.v1",
  splits: "sr.splits.v1",
  current: "sr.current.v1",
  settings: "sr.settings.v1",
  memory: "sr.memory.v1",
  groups: "sr.groups.v1",
};

export function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

let dbPromise = null;
function db() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("IndexedDB indisponível"));
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open("splitreceipt", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("images");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction("images", mode);
    const store = t.objectStore("images");
    const req = fn(store);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

/** images: [{ mimeType, data(base64) }] */
export const saveImages = (receiptId, images) => tx("readwrite", s => s.put(images, receiptId)).catch(() => null);
export const getImages = receiptId => tx("readonly", s => s.get(receiptId)).catch(() => null);
export const deleteImages = receiptId => tx("readwrite", s => s.delete(receiptId)).catch(() => null);

/** Remove imagens de recibos que já não existem em nenhuma divisão. */
export async function pruneImages(keepIds) {
  try {
    const keys = await tx("readonly", s => s.getAllKeys());
    const keep = new Set(keepIds);
    await Promise.all((keys || []).filter(k => !keep.has(k)).map(k => deleteImages(k)));
  } catch { /* sem IndexedDB */ }
}
