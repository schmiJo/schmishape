import { engine } from './engine/client';
import { expectBlob, wholeText } from './engine/blobs';
import { partLabel } from './features/words';
import { fitView } from './commands';
import { doc, documentText, insertPosition, mesh, mutate, partLooks, pushUndo, stopEngine, tidyError, ToolError, unaddInKernel, UNTITLED } from './store/doc';
import { importJob, importRunning, setImportJob, updateImport } from './store/imports';
import { flatDxf, sheetParts, shownSheet } from './store/sheetmetal';
import { activeTab, activeTabId, openInTab } from './store/tabs';
import { toast } from './store/ui';
import { documentFile, isDocumentFile, openDocumentFile } from './store/versions';

/** The file each Part Studio was opened from or saved to, so saving one never writes over another's. */
const handles = new Map<string, any>();
let lastPicked: any = null;

const safeName = () => [doc.title === UNTITLED ? '' : doc.title, activeTab()?.name].filter(Boolean).join(' - ').replace(/[^\w\- ]+/g, '').trim() || 'part';

export async function saveBlob(blob: Blob, name: string, description: string, ext: string) {
  const picker = (window as any).showSaveFilePicker;
  if (picker) {
    try {
      const h = await picker({ suggestedName: name, types: [{ description, accept: { 'application/octet-stream': [ext] } }] });
      const w = await h.createWritable();
      await w.write(blob);
      await w.close();
      return h;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return null;
}

function pickFile(accept: string, types: { description: string; accept: Record<string, string[]> }[]): Promise<File | null> {
  const picker = (window as any).showOpenFilePicker;
  if (picker) {
    return picker({ types })
      .then(async ([h]: any[]) => {
        lastPicked = h;
        return h.getFile();
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') toast(`The file couldn't be opened. ${e.message}`, 'error');
        return null;
      });
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

export async function saveDocument() {
  // A saved file has everything in it, an imported file's text too.
  const text = await wholeText(documentText());
  const tab = activeTabId();
  const handle = handles.get(tab);
  if (handle) {
    try {
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      toast(`Saved ${handle.name}`);
      return;
    } catch {
      handles.delete(tab);
    }
  }
  const h = await saveBlob(new Blob([text], { type: 'application/json' }), `${safeName()}.coreshape`, 'CoreShape document', '.coreshape');
  if (h) {
    handles.set(tab, h);
    toast(`Saved ${h.name}`);
  }
}

const docName = () => (doc.title === UNTITLED ? 'document' : doc.title).replace(/[^\w\- ]+/g, '').trim() || 'document';

/** The whole document, every tab of it, as one file, or a version of it. */
export async function saveWholeDocument(version?: { id: string; name: string }) {
  try {
    const text = await documentFile(version?.id);
    const name = `${docName()}${version ? ` - ${version.name.replace(/[^\w\- ]+/g, '').trim()}` : ''}.schmishape`;
    const h = await saveBlob(new Blob([text], { type: 'application/json' }), name, 'schmishape document', '.schmishape');
    toast(`Saved ${h?.name ?? name}`);
  } catch (e) {
    toast(`The document couldn't be saved. ${(e as Error).message}`, 'error');
  }
}

/** Opens a whole document file in place of this one, which is kept as a version first. */
export async function openWholeDocument() {
  const f = await pickFile('.schmishape,.json', [{ description: 'schmishape document', accept: { 'application/json': ['.schmishape', '.json'] } }]);
  if (!f) return;
  try {
    await openDocumentFile(await f.text(), f.name);
  } catch (e) {
    toast(`${f.name} couldn't be opened. ${(e as Error).message}`, 'error');
  }
}

export async function openFile() {
  lastPicked = null;
  const f = await pickFile('.coreshape,.schmishape,.json', [{ description: 'CoreShape or schmishape document', accept: { 'application/json': ['.coreshape', '.schmishape', '.json'] } }]);
  if (!f) return;
  try {
    const text = await f.text();
    // A whole document, not one Part Studio, opens in place of this one.
    if (isDocumentFile(text)) return void (await openDocumentFile(text, f.name));
    await openInTab(text, f.name.replace(/\.[^.]+$/, ''));
    if (lastPicked) handles.set(activeTabId(), lastPicked);
  } catch (e) {
    toast(`${f.name} couldn't be opened. ${(e as Error).message}`, 'error');
  }
}

/** Reads a file as text in pieces, saying how far it's got, and stopping when asked. */
async function readText(f: File, progress: (fraction: number) => void, stopped: () => boolean): Promise<string | null> {
  const reader = f.stream().getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let done = 0;
  for (;;) {
    if (stopped()) {
      await reader.cancel();
      return null;
    }
    const { value, done: end } = await reader.read();
    if (end) break;
    done += value.byteLength;
    parts.push(decoder.decode(value, { stream: true }));
    progress(f.size ? done / f.size : 1);
  }
  parts.push(decoder.decode());
  return parts.join('');
}

let stopImport = false;
/** Stops the import: while the file is coming off the disk, or by stopping the kernel, which puts the model back. */
export function cancelImport() {
  const stage = importJob()?.stage;
  if (stage !== 'reading' && stage !== 'translating' && stage !== 'drawing') return;
  stopImport = true;
  if (stage !== 'reading') stopEngine();
}

const mb = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

/**
 * Brings a STEP file in as a feature, each solid a part of its own, as Onshape does. A card shows how it's going, and
 * says why if it doesn't work. A failed import leaves nothing behind in the history.
 */
export async function importStep() {
  if (importRunning()) return toast('A file is already being imported.');
  const f = await pickFile('.step,.stp,.p21', [{ description: 'STEP file', accept: { 'application/octet-stream': ['.step', '.stp', '.p21'] } }]);
  if (!f) return;
  stopImport = false;
  const started = performance.now();
  setImportJob({ name: f.name, bytes: f.size, stage: 'reading', read: 0, started, bar: 0 });
  const fail = (error: string, hint?: string) => updateImport({ stage: 'failed', error, hint, ended: performance.now() });
  const stopped = () => updateImport({ stage: 'stopped', ended: performance.now() });

  let text: string | null;
  try {
    text = await readText(f, (read) => updateImport({ read }), () => stopImport);
  } catch (e) {
    return fail(`The file couldn't be read from the disk. ${(e as Error).message}`);
  }
  if (text === null) return stopped();
  if (!text.trim()) return fail('The file is empty.');
  if (!/^\s*ISO-10303-21\s*;/.test(text.slice(0, 400))) {
    return fail('This isn’t a STEP file. A STEP file starts with “ISO-10303-21”, and this one doesn’t.', 'In the program it came from, export it as STEP (AP203, AP214 or AP242).');
  }
  if (/^\s*ISO-10303-28|<\?xml/i.test(text.slice(0, 400))) return fail('This is a STEP XML file, which can’t be read. Only ordinary STEP files can.');
  const solids = (text.match(/MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS/g) ?? []).length;
  const surfaces = (text.match(/SHELL_BASED_SURFACE_MODEL/g) ?? []).length;
  updateImport({ stage: 'translating', read: 1, translating: performance.now(), solids });

  const before = documentText();
  const name = f.name.replace(/\.[^.]+$/, '');
  /** What the kernel said when it refused the file, which then never reaches the page. */
  let refused: string | null = null;
  let id = NaN;
  try {
    // Each solid its own part, as Onshape imports them: merging an assembly's touching parts would be slow, and wrong.
    const feature = { type: 'import_step', text, mode: 'new_body' };
    expectBlob(text);
    await mutate('feature_add', { feature, name, position: insertPosition() }, async (r) => {
      id = Number(/\(id (\d+)\)/.exec(r.text)?.[1]);
      const summary = r.content.map((c) => c.text?.trim() ?? '').find((t) => t.startsWith('{'));
      const step = summary ? JSON.parse(summary).features?.find((x: { id: number }) => x.id === id) : null;
      if (Number.isFinite(id) && step?.state !== 'failed') {
        // It built, perhaps without some solids: the kernel names each one it left out, and why.
        const notes: string[] = (step?.notes ?? []).map(String);
        updateImport({
          stage: 'drawing',
          leftOut: notes.filter((n) => /^left out /.test(n)).map((n) => tidyError(n.replace(/^left out /, ''))),
          repaired: notes.filter((n) => /^repaired /.test(n)).map((n) => tidyError(n.replace(/^repaired /, ''))),
        });
        return;
      }
      // Nothing is kept of a file that couldn't be read, and there's nothing to undo. Taken out before the page
      // catches up, a big file costs no second wait.
      refused = step?.error ?? '';
      if (Number.isFinite(id)) await unaddInKernel(id);
      throw new ToolError('refused');
    });
  } catch (e) {
    expectBlob(null);
    if (stopImport) return stopped();
    const crash = e instanceof ToolError ? e.crash : undefined;
    if (crash) {
      const memory = /memory|alloc|unreachable|out of bounds/i.test(crash);
      return fail(
        memory
          ? `The kernel ran out of memory reading this ${mb(f.size)} file, so it wasn’t added.`
          : `The kernel crashed reading this file, so it wasn’t added. It said: ${crash}`,
        memory ? 'Export fewer parts at a time, or the parts as separate files, and import those.' : undefined,
      );
    }
    if (refused === null) return fail(`It couldn’t be added. ${(e as Error).message}`);
  }
  if (stopImport) return stopped();
  if (refused !== null) {
    const raw = (refused as string).replace(/^(near-degenerate|invalid) input: /i, '');
    const said = tidyError(raw.replace(/^this STEP file can.t be read: /i, '')).replace(/\.?$/, '.');
    if (/imported solid isn.t valid/i.test(raw)) {
      const detail = tidyError(raw.replace(/^.*imported solid isn.t valid:\s*/i, '')).replace(/\.?$/, '.');
      return fail(
        `${solids > 1 ? 'None of the solids in this file are valid' : 'The solid in this file isn’t a valid solid'}, so nothing was imported. The kernel found: ${detail}`,
        'Exporting it again from its own program, with a tighter tolerance, often repairs it.',
      );
    }
    if (/^this STEP file can.t be read/i.test(raw)) {
      return fail(`The file couldn’t be read. It may be damaged, or cut short. The kernel stopped at: ${said.charAt(0).toLowerCase()}${said.slice(1)}`, 'Download it or export it again, and import the new copy.');
    }
    const hint = !solids && !surfaces
      ? 'The file has no solids or surfaces in it. It may hold only a mesh, or drawings.'
      : undefined;
    return fail(raw ? said : 'The kernel didn’t say why.', hint);
  }
  pushUndo(before);
  const tag = `f${id}`;
  const parts = (mesh()?.parts ?? []).filter((p) => p.name === tag || p.name.startsWith(`${tag}.`)).length;
  updateImport({ stage: 'done', parts, ended: performance.now() });
  fitView();
}

export async function exportStep() {
  const r = await engine.call('export', { format: 'step' });
  if (!r.ok) return toast(r.text, 'error');
  await saveBlob(new Blob([r.text], { type: 'application/step' }), `${safeName()}.step`, 'STEP file', '.step');
}

/** The flat pattern on show, or the only one, as a DXF to cut it from. */
export async function exportFlatDxf() {
  const part = shownSheet();
  if (!part?.flat) return toast(part?.error ?? 'There is no sheet metal part to lay flat.', 'error');
  const label = partLabel(mesh()?.parts ?? [], part.body, partLooks()).replace(/[^\w\- ]+/g, '').trim();
  const name = sheetParts().length > 1 && label ? `${safeName()} - ${label} flat` : `${safeName()} flat`;
  await saveBlob(new Blob([flatDxf(part.flat)], { type: 'image/vnd.dxf' }), `${name}.dxf`, 'DXF file', '.dxf');
}

export async function exportStl() {
  const bytes = await engine.stl();
  if (!bytes.length) return toast('There is no solid to export yet.', 'error');
  await saveBlob(new Blob([bytes as BlobPart], { type: 'model/stl' }), `${safeName()}.stl`, 'STL file', '.stl');
}

/** A small part built only through the tool layer, the same way an AI would build it. */
export async function loadExample() {
  const sketch = {
    format: 'coreshape-sketch',
    version: 1,
    entities: [
      [[0, 0], [40, 0]], [[40, 0], [40, 8]], [[40, 8], [8, 8]], [[8, 8], [8, 45]], [[8, 45], [0, 45]], [[0, 45], [0, 0]],
    ].map(([start, end], i) => ({ id: i + 1, type: 'line', start, end })),
    constraints: [] as any[],
  };
  const add = (c: any) => sketch.constraints.push({ id: sketch.constraints.length + 1, ...c });
  for (let i = 1; i <= 6; i++) add({ type: 'coincident', a: `${i}.end`, b: `${(i % 6) + 1}.start` });
  add({ type: 'coincident', a: '1.start', b: 'origin' });
  [1, 3, 5].forEach((a) => add({ type: 'horizontal', a: String(a) }));
  [2, 4, 6].forEach((a) => add({ type: 'vertical', a: String(a) }));
  add({ type: 'distance', a: '1', value: 'depth' });
  add({ type: 'distance', a: '2', value: 'wall' });
  add({ type: 'distance', a: '5', value: 'wall' });
  add({ type: 'distance', a: '6', value: 'height' });
  const before = documentText();
  await mutate('document_new');
  for (const [name, value] of [['width', 60], ['depth', 40], ['height', 45], ['wall', 8], ['hole', 9]]) await mutate('parameter_set', { name, value });
  await mutate('feature_add', { name: 'Section', feature: { type: 'constrained_sketch', plane: { origin: [0, 0, 0], z: [0, -1, 0], x: [1, 0, 0] }, sketch } });
  await mutate('feature_add', { name: 'Body', feature: { type: 'extrude', sketch: 1, start: '-width', length: 'width' } });
  const edges = JSON.parse((await engine.call('edges_list')).text);
  const inner = edges.find((e: any) => {
    const s = new Set(e.name.split('|'));
    return s.size === 2 && s.has('f2:side.3') && s.has('f2:side.4');
  });
  await mutate('feature_add', { name: 'Inner round', feature: { type: 'fillet', edges: inner.select, radius: 6 } });
  await mutate('feature_add', { name: 'Hole positions', feature: { type: 'sketch', regions: [{ outer: { type: 'circle', cx: 26, cy: 'width * 0.25', r: 'hole / 2' } }, { outer: { type: 'circle', cx: 26, cy: 'width * 0.75', r: 'hole / 2' } }] } });
  await mutate('feature_add', { name: 'Holes', feature: { type: 'extrude', sketch: 4, start: -1, length: 'wall + 2', mode: 'remove' } });
  pushUndo(before);
  handles.delete(activeTabId());
}
