// A large text in a document, such as an imported STEP file's 114 MB, kept apart from it. The kernel gives such a text
// as `{"bytes": n, "sha256": "..."}` when asked, and takes it back in `blobs` when the document is opened. So the page,
// its undo history and its autosave hold a small document, and the texts are kept once each: here while the page is
// open, and in IndexedDB between visits, where there's room for them.

/** Texts longer than this, in bytes, are kept apart. */
export const BIG_TEXT = 100_000;

const kept = new Map<string, string>();
/** Hashes known to be in IndexedDB, so a sync needn't look again. */
const stored = new Set<string>();
/** A text just sent to the kernel, whose hash isn't known yet: the next sync names it. */
let pending: string | null = null;

const DB = 'schmishape-blobs';
const STORE = 'texts';
let opening: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

async function request<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    try {
      const r = run(d.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

function keep(hash: string, text: string) {
  kept.set(hash, text);
  if (stored.has(hash)) return;
  // Without room in IndexedDB it's kept for this visit only, as a document too big for the autosave was before.
  void request('readwrite', (s) => s.put(text, hash)).then((done) => {
    if (done !== undefined) stored.add(hash);
  });
}

/** Keeps a text by its hash for good, as a document file being opened brings its imports with it. */
export async function storeBlob(hash: string, t: string): Promise<boolean> {
  kept.set(hash, t);
  const done = await request('readwrite', (s) => s.put(t, hash));
  if (done !== undefined) stored.add(hash);
  return done !== undefined;
}

async function text(hash: string): Promise<string | undefined> {
  const found = kept.get(hash);
  if (found !== undefined) return found;
  const read = await request<string>('readonly', (s) => s.get(hash));
  if (typeof read === 'string') {
    kept.set(hash, read);
    stored.add(hash);
  }
  return read;
}

const HASH = /"sha256"\s*:\s*"([0-9a-f]{64})"/g;
export const blobHashes = (doc: string) => [...new Set([...doc.matchAll(HASH)].map((m) => m[1]))];
const isRef = (v: any) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.sha256 === 'string' && typeof v.bytes === 'number' && Object.keys(v).length === 2;

/** Says that this text is about to go into the document, so the sync after it knows it without asking the kernel for it. */
export function expectBlob(t: string | null) {
  pending = t;
}

/**
 * Makes sure every text the small document names is kept. A new one is the text just imported, or, opened from a file,
 * one asked for from the kernel once, by the whole document, and matched up by where it is.
 */
export async function learnBlobs(small: string, whole: () => Promise<string>) {
  const unknown: string[] = [];
  for (const h of blobHashes(small)) if (!kept.has(h) && (await text(h)) === undefined) unknown.push(h);
  const sent = pending;
  pending = null;
  if (!unknown.length) return;
  if (unknown.length === 1 && sent !== null) return keep(unknown[0], sent);
  const walk = (a: any, b: any) => {
    if (isRef(a) && typeof b === 'string') return keep(a.sha256, b);
    if (a && b && typeof a === 'object' && typeof b === 'object') for (const k of Object.keys(a)) walk(a[k], b[k]);
  };
  walk(JSON.parse(small), JSON.parse(await whole()));
}

/** The texts a small document needs to open, by hash. Those that can't be found are left for the kernel to name. */
export async function blobsFor(doc: string): Promise<Record<string, string> | null> {
  const hashes = blobHashes(doc);
  if (!hashes.length) return null;
  const out: Record<string, string> = {};
  for (const h of hashes) {
    const t = await text(h);
    if (t !== undefined) out[h] = t;
  }
  return out;
}

/** The document with its texts back in, as a saved file has them. */
export async function wholeText(doc: string): Promise<string> {
  if (!blobHashes(doc).length) return doc;
  const blobs = (await blobsFor(doc)) ?? {};
  const fill = (v: any): any => {
    if (isRef(v)) return blobs[v.sha256] ?? v;
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return JSON.stringify(fill(JSON.parse(doc)), null, 2);
}

/** Forgets the stored texts no kept document names any more. `docs` is every document the app still keeps. */
export async function pruneBlobs(docs: (string | null | undefined)[]) {
  const used = new Set(docs.flatMap((d) => (d ? blobHashes(d) : [])));
  for (const h of kept.keys()) used.add(h);
  const keys = await request<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
  for (const k of keys ?? []) if (typeof k === 'string' && !used.has(k)) void request('readwrite', (s) => s.delete(k));
}
