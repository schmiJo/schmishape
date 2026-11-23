import { createSignal } from 'solid-js';
import { parseAssembly } from '../assembly/model';
import { knownStudio, loadStudio } from '../assembly/parts';
import { derivedCopies } from '../assembly/extras';
import { wholeText } from '../engine/blobs';
import { engine } from '../engine/client';
import { storage } from '../store/doc';
import { activeTabId, drawingHooks, lastStudioTab, tabById, tabDocumentText, tabs } from '../store/tabs';
import { toast } from '../store/ui';
import { quatRotate, type V3 } from '../viewport/math';

/**
 * A Drawing tab, as in Onshape: an engineering drawing of a Part Studio, one of its parts, or an assembly, which the
 * kernel lays out each time it's shown, so it follows the model. What's kept is the kernel's own drawing JSON (see
 * FILE_FORMAT.md, Drawings) and where it's from, by tab.
 */
export type ViewType = 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right' | 'iso' | 'section';
/** A point: a place, or a sketch's point `{sketch, point}`, which follows the sketch. */
export type Spot = V3 | { sketch: number; point: string };
export interface DrawingView {
  id: number;
  type: ViewType;
  point?: V3;
  normal?: V3;
  letter?: string;
  at?: [number, number];
  scale?: number;
  hidden?: boolean;
}
export interface DrawingDim {
  id: number;
  view: number;
  type: 'distance' | 'diameter' | 'radius';
  a?: Spot;
  b?: Spot;
  near?: Spot;
  along?: 'horizontal' | 'vertical' | 'aligned';
  offset?: number;
  text?: string;
}
export const TITLE_FIELDS = ['title', 'number', 'part', 'material', 'author', 'date', 'company', 'revision'] as const;
export type TitleField = (typeof TITLE_FIELDS)[number];
export interface KernelDrawing {
  sheet: string;
  projection: 'first_angle' | 'third_angle';
  scale?: number | null;
  auto_dimensions: boolean;
  next_id: number;
  views: DrawingView[];
  dimensions: DrawingDim[];
  title: Partial<Record<TitleField, string>>;
}
/** A Part Studio's tab and maybe one of its parts, or an assembly's tab. */
export interface DrawingSource { tab: string; body?: string | null }
export interface DrawingData { format: 'schmishape-drawing'; version: 1; source: DrawingSource; drawing: KernelDrawing }

export const SHEETS = ['A4', 'A3', 'A2', 'A1', 'A0', 'ANSI A', 'ANSI B', 'ANSI C', 'ANSI D', 'ANSI E'];
/** Scales offered besides fitting, as drawings write them. */
export const SCALES: [string, number][] = [['5:1', 5], ['2:1', 2], ['1:1', 1], ['1:2', 0.5], ['1:5', 0.2], ['1:10', 0.1], ['1:20', 0.05], ['1:50', 0.02]];
export const VIEW_NAMES: Record<ViewType, string> = { front: 'Front', back: 'Back', top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right', iso: 'Isometric', section: 'Section' };

const drawingKey = (tab: string) => `schmishape.drawing.${tab}`;

/** Front, top and right, laid out by projection, and an isometric one, with overall sizes and hole diameters. */
export function standardDrawing(): KernelDrawing {
  return {
    sheet: 'A3',
    projection: 'first_angle',
    auto_dimensions: true,
    next_id: 5,
    views: [{ id: 1, type: 'front' }, { id: 2, type: 'top' }, { id: 3, type: 'right' }, { id: 4, type: 'iso' }],
    dimensions: [],
    title: {},
  };
}

export function parseDrawing(text: string | null): DrawingData | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    if (v?.format === 'schmishape-drawing' && v.source && v.drawing && Array.isArray(v.drawing.views)) return v;
  } catch {
    /* It can't be read, so it's as if there were none. */
  }
  return null;
}

export const [drawingData, setDrawingData] = createSignal<DrawingData | null>(null);
export interface Rendered { url: string; svg: string; scale: string; width: number; height: number; notes: string[] }
export const [rendered, setRendered] = createSignal<Rendered | null>(null);
export const [drawingError, setDrawingError] = createSignal<string | null>(null);
export const [drawingBusy, setDrawingBusy] = createSignal(false);
export const [drawingCanUndo, setDrawingCanUndo] = createSignal(false);
export const [drawingCanRedo, setDrawingCanRedo] = createSignal(false);
/** The form open over the sheet: adding a section or a dimension, or none. */
export const [drawingForm, setDrawingForm] = createSignal<'section' | 'dimension' | null>(null);

let here = '';
const stacks = new Map<string, { undo: string[]; redo: string[] }>();
const stack = () => {
  if (!stacks.has(here)) stacks.set(here, { undo: [], redo: [] });
  return stacks.get(here)!;
};
const save = () => {
  const d = drawingData();
  if (here && d) storage.set(drawingKey(here), JSON.stringify(d));
};

/** What the source is called: "Part Studio 1", or "Part 2 of Part Studio 1". */
export async function sourceName(s: DrawingSource) {
  const t = tabById(s.tab);
  if (!t) return 'a deleted tab';
  if (!s.body) return t.name;
  const parts = await loadStudio(s.tab, tabDocumentText(s.tab));
  return `${parts.parts.find((p) => p.body === s.body)?.label ?? s.body} of ${t.name}`;
}

/** The kernel's arguments for drawing this: a Part Studio's whole text, or an assembly's parts where they are now. */
async function argsFor(d: DrawingData): Promise<object> {
  const t = tabById(d.source.tab);
  if (!t) throw new Error('The tab this drawing shows has been deleted. Pick what to draw under Source.');
  if (t.kind === 'part-studio') {
    const text = tabDocumentText(t.id);
    if (!text) throw new Error(`${t.name} has nothing in it to draw yet.`);
    return { drawing: d.drawing, doc: await wholeText(text), ...(d.source.body ? { body: d.source.body } : {}) };
  }
  if (t.kind === 'assembly') {
    const a = parseAssembly(storage.get(`schmishape.assembly.${t.id}`));
    const docs = new Map<string, string>();
    const parts = [];
    // Patterns and replicates place copies from where their instances are, which a replicate finds on its part's faces.
    for (const tab of new Set(a.instances.map((i) => i.tab))) if (tabById(tab)) await loadStudio(tab, tabDocumentText(tab));
    const partOf = (i: { tab: string; body: string }) => knownStudio(i.tab)?.parts.find((p) => p.body === i.body);
    const made = derivedCopies(a, partOf).map((c) => ({ ...c.of, pose: c.pose }));
    for (const i of [...a.instances, ...made]) {
      if (i.hidden || !tabById(i.tab)) continue;
      if (!docs.has(i.tab)) {
        const text = tabDocumentText(i.tab);
        if (!text) continue;
        docs.set(i.tab, await wholeText(text));
      }
      parts.push({
        doc: docs.get(i.tab),
        body: partOf(i)?.kernel ?? i.body,
        at: { origin: i.pose.p, x: quatRotate(i.pose.q, [1, 0, 0]), y: quatRotate(i.pose.q, [0, 1, 0]), z: quatRotate(i.pose.q, [0, 0, 1]) },
      });
    }
    if (!parts.length) throw new Error(`${t.name} has no parts shown to draw yet.`);
    return { drawing: d.drawing, parts };
  }
  throw new Error(`${t.name} can't be drawn.`);
}

let generation = 0;
/** Lays the drawing out again, from its source as it is now. */
export async function redraw() {
  const d = drawingData();
  if (!d) return;
  const mine = ++generation;
  setDrawingBusy(true);
  try {
    const r = await engine.drawing({ ...(await argsFor(d)), format: 'svg' });
    if (mine !== generation) return;
    if (!r.ok) throw new Error(r.error);
    const old = rendered();
    if (old) URL.revokeObjectURL(old.url);
    setRendered({ url: URL.createObjectURL(new Blob([r.data], { type: 'image/svg+xml' })), svg: r.data, scale: r.scale, width: r.width, height: r.height, notes: r.notes });
    setDrawingError(null);
  } catch (e) {
    if (mine !== generation) return;
    setDrawingError((e as Error).message.replace(/^invalid input: /, ''));
  } finally {
    if (mine === generation) setDrawingBusy(false);
  }
}

/** The Part Studio a new drawing shows when none is given: the one last open, or the first. */
function defaultSource(): DrawingSource {
  const studios = tabs().filter((t) => t.kind === 'part-studio');
  return { tab: (studios.find((t) => t.id === lastStudioTab()) ?? studios[0])?.id ?? '' };
}

async function enterDrawing(tab: string) {
  here = tab;
  let d = parseDrawing(storage.get(drawingKey(tab)));
  if (!d) {
    const source = defaultSource();
    d = { format: 'schmishape-drawing', version: 1, source, drawing: { ...standardDrawing(), title: { title: tabById(tab)?.name ?? '', part: await sourceName(source) } } };
  }
  setDrawingData(d);
  setRendered(null);
  setDrawingError(null);
  setDrawingForm(null);
  const s = stack();
  setDrawingCanUndo(s.undo.length > 0);
  setDrawingCanRedo(s.redo.length > 0);
  save();
  await redraw();
}

function leaveDrawing() {
  save();
  generation++;
  setDrawingBusy(false);
  setDrawingForm(null);
  here = '';
}

drawingHooks.enter = enterDrawing;
drawingHooks.leave = leaveDrawing;
drawingHooks.copy = (from, to) => {
  const text = storage.get(drawingKey(from));
  if (text) storage.set(drawingKey(to), text);
};
drawingHooks.take = (tab) => {
  const text = storage.get(drawingKey(tab));
  storage.remove(drawingKey(tab));
  return text;
};
drawingHooks.put = (tab, text) => {
  if (text) storage.set(drawingKey(tab), text);
};
drawingHooks.create = (tab, source) => {
  const name = tabById(source.tab)?.name ?? '';
  const d: DrawingData = { format: 'schmishape-drawing', version: 1, source, drawing: { ...standardDrawing(), title: { title: name } } };
  storage.set(drawingKey(tab), JSON.stringify(d));
  void sourceName(source).then((part) => {
    const kept = parseDrawing(storage.get(drawingKey(tab)));
    if (!kept || kept.drawing.title.part) return;
    kept.drawing.title.part = part;
    storage.set(drawingKey(tab), JSON.stringify(kept));
    if (here === tab) setDrawingData(kept);
  });
};

/** Changes the drawing, as one step to undo, and draws it again. A change the kernel can't lay out is taken back. */
export async function changeDrawing(fn: (d: DrawingData) => void, keepIfFails = false) {
  const now = drawingData();
  if (!now) return;
  const before = JSON.stringify(now);
  const next: DrawingData = JSON.parse(before);
  fn(next);
  const after = JSON.stringify(next);
  if (after === before) return;
  setDrawingData(next);
  await redraw();
  if (drawingError() && !keepIfFails) {
    const why = drawingError();
    setDrawingData(JSON.parse(before));
    await redraw();
    toast(why ?? 'That change couldn\'t be drawn.', 'error');
    return false;
  }
  const s = stack();
  s.undo.push(before);
  s.redo = [];
  setDrawingCanUndo(true);
  setDrawingCanRedo(false);
  save();
  return true;
}

function step(from: string[], to: string[]) {
  const text = from.pop();
  const now = drawingData();
  if (!text || !now) return;
  to.push(JSON.stringify(now));
  setDrawingData(JSON.parse(text));
  const s = stack();
  setDrawingCanUndo(s.undo.length > 0);
  setDrawingCanRedo(s.redo.length > 0);
  save();
  void redraw();
}
export const drawingUndo = () => step(stack().undo, stack().redo);
export const drawingRedo = () => step(stack().redo, stack().undo);

const nextId = (d: DrawingData) => {
  const top = Math.max(0, ...d.drawing.views.map((v) => v.id), ...d.drawing.dimensions.map((x) => x.id));
  const id = Math.max(d.drawing.next_id ?? 1, top + 1);
  d.drawing.next_id = id + 1;
  return id;
};

export const addView = (type: Exclude<ViewType, 'section'>) => changeDrawing((d) => { d.drawing.views.push({ id: nextId(d), type }); });

/** The next section letter not in use: A, B, ..., skipping I and O, which read as numbers. */
export function nextLetter(d: DrawingData | null) {
  const used = new Set(d?.drawing.views.map((v) => v.letter).filter(Boolean));
  return [...'ABCDEFGHJKLMNPQRSTUVWXYZ'].find((l) => !used.has(l)) ?? 'Z';
}

export const addSection = (point: V3, normal: V3, letter: string) => changeDrawing((d) => { d.drawing.views.push({ id: nextId(d), type: 'section', point, normal, letter }); });

/** Adds a dimension. One the kernel can't place, as when its point isn't in the view, is refused with its reason. */
export async function addDimension(dim: Omit<DrawingDim, 'id'>) {
  let id = 0;
  const ok = await changeDrawing((d) => { id = nextId(d); d.drawing.dimensions.push({ ...dim, id }); });
  if (!ok) return ok;
  const why = rendered()?.notes.find((n) => n.startsWith(`dimension ${id}:`));
  if (why) {
    drawingUndo();
    stack().redo.pop();
    setDrawingCanRedo(stack().redo.length > 0);
    toast(why.replace(/^dimension \d+: /, 'That dimension can\'t be drawn: '), 'error');
    return false;
  }
  return true;
}

/** Takes out a view, with its dimensions, or a dimension. A drawing keeps at least one view. */
export function removeItem(id: number) {
  const d = drawingData();
  if (!d) return;
  if (d.drawing.views.some((v) => v.id === id) && d.drawing.views.length === 1) return toast('A drawing needs at least one view.');
  void changeDrawing((x) => {
    x.drawing.views = x.drawing.views.filter((v) => v.id !== id);
    x.drawing.dimensions = x.drawing.dimensions.filter((m) => m.id !== id && m.view !== id);
  });
}

/** Points a drawing of a Part Studio can name and follow: each sketch's points, by sketch and name. */
export interface NamedPoint { label: string; spot: { sketch: number; point: string }; at: [number, number] }
export function sketchPoints(source: DrawingSource | undefined): NamedPoint[] {
  if (!source || tabById(source.tab)?.kind !== 'part-studio') return [];
  const text = tabDocumentText(source.tab);
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    const out: NamedPoint[] = [];
    for (const f of v.features ?? []) {
      if (f.type !== 'constrained_sketch' || f.suppressed) continue;
      for (const e of f.sketch?.entities ?? []) {
        if (e.type === 'point' && !e.construction) out.push({ label: `${f.name ?? `Sketch ${f.id}`} · point ${e.id}`, spot: { sketch: f.id, point: String(e.id) }, at: e.at });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Where the source's parts are, roughly, for a section's default place. */
export async function sourceBounds(source: DrawingSource): Promise<{ min: V3; max: V3 } | null> {
  const t = tabById(source.tab);
  if (t?.kind !== 'part-studio') return null;
  const s = await loadStudio(t.id, tabDocumentText(t.id));
  const parts = source.body ? s.parts.filter((p) => p.body === source.body) : s.parts;
  if (!parts.length) return null;
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p.min[k]); max[k] = Math.max(max[k], p.max[k]); }
  return { min, max };
}

const FORMATS = { svg: ['image/svg+xml', 'SVG drawing'], pdf: ['application/pdf', 'PDF'], dxf: ['application/dxf', 'DXF drawing'], png: ['image/png', 'PNG image'] } as const;
export type DrawingFormat = keyof typeof FORMATS;

/** Writes the drawing as a file to save. PNG at 200 dots per inch. */
export async function exportDrawing(format: DrawingFormat) {
  const d = drawingData();
  if (!d) return;
  try {
    const r = await engine.drawing({ ...(await argsFor(d)), format, dpi: 200 });
    if (!r.ok) throw new Error(r.error);
    const bytes = format === 'pdf' || format === 'png' ? Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)) : r.data;
    const name = `${(tabById(activeTabId())?.name ?? 'drawing').replace(/[^\w\- ]+/g, '').trim() || 'drawing'}.${format}`;
    const { saveBlob } = await import('../files');
    await saveBlob(new Blob([bytes], { type: FORMATS[format][0] }), name, FORMATS[format][1], `.${format}`);
  } catch (e) {
    toast(`The drawing couldn't be exported. ${(e as Error).message}`, 'error');
  }
}
