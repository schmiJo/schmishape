// Onshape's versions: the whole document as it stood, by name, to go back to. A version holds every tab, Part Studio and
// assembly, and where dimensions sit, as the browser keeps them. Versions are kept in IndexedDB, which has room for them,
// and a large import in one is kept once, by its hash, with the others. The same snapshot, with those imports put back
// in, is a document file, which keeps everything somewhere other than this browser.
import { createSignal } from 'solid-js';
import { blobHashes, blobsFor, storeBlob } from '../engine/blobs';
import { doc, flushAutosave, setAutosaveKey, storage, UNTITLED } from './doc';

/** What a version or a document file holds: the browser's keys for this document, and what's in them. */
const WORKSPACE = /^schmishape\.(tabs|title|(document|assembly|drawing|dimension-places)\.[^.]+)$/;
export const FILE_FORMAT = 'schmishape-document';

export interface VersionInfo { id: string; name: string; description: string; created: number; auto: boolean }
interface Version extends VersionInfo { entries: Record<string, string> }

export const [versions, setVersions] = createSignal<VersionInfo[]>([]);
export const [versionsOpen, setVersionsOpen] = createSignal(false);

const DB = 'schmishape-versions';
const STORE = 'versions';
let opening: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

function request<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => {
    if (!d) throw new Error('This browser has no room for versions here. Save the document to a file instead.');
    return new Promise<T>((resolve, reject) => {
      const r = run(d.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error('The version couldn’t be kept.'));
    });
  });
}

const info = ({ entries: _e, ...rest }: Version): VersionInfo => rest;

/** Reads the list again, newest first. */
export async function loadVersions() {
  try {
    const all = await request<Version[]>('readonly', (s) => s.getAll());
    setVersions(all.map(info).sort((a, b) => b.created - a.created));
  } catch {
    setVersions([]);
  }
}

/** Every document text the versions hold, so the imports they name aren't forgotten. */
export async function versionTexts(): Promise<string[]> {
  try {
    const all = await request<Version[]>('readonly', (s) => s.getAll());
    return all.flatMap((v) => Object.values(v.entries));
  } catch {
    return [];
  }
}

/** The document as the browser keeps it just now, with the open Part Studio's last change in. */
export function snapshot(): Record<string, string> {
  flushAutosave();
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && WORKSPACE.test(k)) out[k] = localStorage.getItem(k) ?? '';
    }
  } catch {
    // Without storage there's nothing kept to take.
  }
  return out;
}

/** The next free name like "V3", as Onshape numbers them. */
export function nextVersionName() {
  const names = new Set(versions().map((v) => v.name));
  let n = versions().filter((v) => !v.auto).length + 1;
  while (names.has(`V${n}`)) n++;
  return `V${n}`;
}

export async function createVersion(name: string, description = '', auto = false): Promise<VersionInfo> {
  const v: Version = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: name.trim() || nextVersionName(), description: description.trim(), created: Date.now(), auto, entries: snapshot() };
  await request('readwrite', (s) => s.put(v));
  await loadVersions();
  return info(v);
}

export async function deleteVersion(id: string) {
  await request('readwrite', (s) => s.delete(id));
  await loadVersions();
}

export async function renameVersion(id: string, name: string, description?: string) {
  const v = await request<Version | undefined>('readonly', (s) => s.get(id));
  if (!v) return;
  v.name = name.trim() || v.name;
  if (description !== undefined) v.description = description.trim();
  await request('readwrite', (s) => s.put(v));
  await loadVersions();
}

/**
 * Puts a document in place of this one and opens it. What's here now is kept as a version first, so going back is
 * never a loss. Opening it fresh, as the page does at the start, is what makes every tab read it.
 */
async function replaceWith(entries: Record<string, string>, before: string, blobs: Record<string, string> = {}) {
  await createVersion(before, '', true);
  for (const [hash, text] of Object.entries(blobs)) await storeBlob(hash, text);
  // Nothing of the old document may be written back over the new one before the page opens it.
  setAutosaveKey(null);
  const old: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && WORKSPACE.test(k)) old.push(k);
  }
  for (const k of old) storage.remove(k);
  for (const [k, v] of Object.entries(entries)) if (WORKSPACE.test(k)) storage.set(k, v);
  location.reload();
}

export async function restoreVersion(id: string) {
  const v = await request<Version | undefined>('readonly', (s) => s.get(id));
  if (!v) throw new Error('That version is gone.');
  // One kept automatically is named for what it was before, so its own name would only nest.
  await replaceWith(v.entries, v.auto ? 'Before going back' : `Before restoring ${v.name}`);
}

/** The document, or a version of it, as one file: every tab, with the imports' texts in. */
export async function documentFile(id?: string): Promise<string> {
  const entries = id ? (await request<Version | undefined>('readonly', (s) => s.get(id)))?.entries : snapshot();
  if (!entries) throw new Error('That version is gone.');
  const blobs: Record<string, string> = {};
  for (const text of Object.values(entries)) {
    if (!blobHashes(text).length) continue;
    Object.assign(blobs, (await blobsFor(text)) ?? {});
  }
  const title = (entries['schmishape.title'] ?? doc.title) || UNTITLED;
  return JSON.stringify({ format: FILE_FORMAT, version: 1, title, saved: new Date().toISOString(), entries, blobs });
}

/** Whether a file's text is a whole document, rather than one Part Studio. */
export const isDocumentFile = (text: string) => new RegExp(`^\\s*\\{\\s*"format"\\s*:\\s*"${FILE_FORMAT}"`).test(text.slice(0, 200));

/** Opens a document file in place of this document, after keeping this one as a version. */
export async function openDocumentFile(text: string, name: string) {
  const d = JSON.parse(text);
  if (d?.format !== FILE_FORMAT || !d.entries || typeof d.entries !== 'object') throw new Error('It isn’t a schmishape document.');
  if (!Object.keys(d.entries).some((k) => k === 'schmishape.tabs')) throw new Error('It has no tabs in it.');
  const entries = Object.fromEntries(Object.entries(d.entries).filter((e): e is [string, string] => typeof e[1] === 'string'));
  const blobs = Object.fromEntries(Object.entries(d.blobs ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
  await replaceWith(entries, `Before opening ${name}`, blobs);
}
