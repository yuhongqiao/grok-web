export const draftKey = (key) => `codex-web-draft:${key}`;

// Files can exceed sessionStorage's quota. Keep their drafts in IndexedDB,
// scoped to this browser tab just like the text drafts.
function fileKey(key) {
  let tab = sessionStorage.getItem("codex-web-tab");
  if (!tab) { tab = crypto.randomUUID(); sessionStorage.setItem("codex-web-tab", tab); }
  return `${tab}:${key}`;
}

function files(key, value) {
  const scoped = fileKey(key);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("codex-web-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("files", value === undefined ? "readonly" : "readwrite");
      const store = tx.objectStore("files");
      const operation = value === undefined ? store.get(scoped) : value.length ? store.put(value, scoped) : store.delete(scoped);
      tx.oncomplete = () => { db.close(); resolve(operation.result || []); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

export const loadAttachments = (key) => files(key);
export const saveAttachments = (key, value) => files(key, value);
