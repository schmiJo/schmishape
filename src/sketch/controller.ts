import { batch, createSignal } from 'solid-js';
import { partGeometry } from './parts';
import { appWith, doc, documentText, edgeList, mesh, holdBar, insertPosition, isHidden, mutate, nextName, pushUndo, returnBar, setRollback, sketchRegions, ToolError, type HeldBar } from '../store/doc';
import { emptyLinks, readLinks, type SketchLinks } from './links';
import { clearSelection, selectedFeature, setHoverPlane, setMode, setSelectedFeature, sketchesHidden, toast } from '../store/ui';
import { view } from '../viewport/instance';
import { loadPlaces, savePlaces } from './dimension';
import { emptySketch, placementOf, PLANES, type Plane, type SketchData } from './geometry';
import { sketchPlane } from '../store/planes';
import { SketchSession } from './session';

export const [session, setSession] = createSignal<SketchSession | null>(null);

/** What ties a sketch's offsets and patterns together, as the document keeps it. */
export function sketchLinksOf(id: number): SketchLinks {
  const all = doc.app?.sketch_links;
  return readLinks(all && typeof all === 'object' ? all[String(id)] : undefined);
}

/** Keeps a sketch's links with the document, when they've changed. */
async function saveLinks(id: number, links: SketchLinks) {
  const all: Record<string, unknown> = JSON.parse(JSON.stringify(doc.app?.sketch_links ?? {}));
  const was = JSON.stringify(all[String(id)] ?? null);
  if (emptyLinks(links)) delete all[String(id)];
  else all[String(id)] = links;
  if (JSON.stringify(all[String(id)] ?? null) === was) return;
  await mutate('app_set', appWith({ sketch_links: Object.keys(all).length ? all : undefined }));
}

/** Starts a sketch on a plane. `placement` is what the file will say it's on, such as a plane feature it follows. */
export function startSketch(plane: Plane, placement: unknown = null) {
  const r = view.renderer;
  if (!r) return;
  const name = nextName('Sketch');
  const s = new SketchSession(null, plane, name, emptySketch(), r.camera, view.redraw, loadPlaces(null));
  s.placement = placement;
  s.context = { plane: placement ?? placementOf(plane), position: insertPosition() };
  enter(s);
  void loadParts(s);
}

/**
 * A part's corners and edges to pick while sketching. The view shows the model as it stood before the sketch, so they're
 * read from the view's own model, numbered as its edges are for picking.
 */
async function loadParts(s: SketchSession) {
  s.pickModel = (x, y) => view.renderer?.pick(x, y) ?? null;
  const g = partGeometry(await edgeList(), mesh());
  if (session() === s) s.setPart(g);
}

/** Entering a sketch only swaps the toolbar. The camera and the model stay exactly as they were. */
function enter(s: SketchSession) {
  batch(() => {
    clearSelection();
    setHoverPlane(null);
    setSession(s);
    setMode('sketch');
  });
  view.renderer?.invalidate();
}

function quatFor(plane: Plane) {
  return view.renderer!.camera.rotFromBasis(plane.x, plane.y, plane.z);
}

/** Turns the view to look straight at a plane. */
export function normalTo(plane: Plane) {
  view.renderer?.camera.animateTo({ rot: quatFor(plane) }, 320);
  view.renderer?.invalidate();
}

export function looksAtSketch() {
  const s = session();
  if (s) view.renderer?.camera.animateTo({ rot: quatFor(s.plane) }, 320);
}

/** Where the rollback bar was before opening a sketch to edit, while the model is rolled back to that sketch. */
let heldBar: HeldBar | null = null;

/** Opens a sketch feature, with the model as it stood at that sketch. The camera stays where it was, as Onshape's does. */
export function editSketch(id: number) {
  const f = doc.features.find((x) => x.id === id);
  if (!f || !view.renderer) return;
  if (f.type !== 'constrained_sketch') {
    toast('This sketch was written as regions rather than drawn, so it can only be changed as data.');
    return;
  }
  const plane = sketchPlane(f);
  const data: SketchData = JSON.parse(JSON.stringify(f.sketch));
  heldBar = holdBar();
  const s = new SketchSession(id, plane, f.name, data, view.renderer.camera, view.redraw, loadPlaces(id), sketchLinksOf(id));
  // It stays on whatever it was on, a plane it follows or its own numbers, expressions and all.
  s.placement = f.plane ?? null;
  s.context = { plane: f.plane, position: doc.features.findIndex((x) => x.id === id) };
  enter(s);
  // Once the model has gone back to how it stood at this sketch, that's what there is to pick.
  void setRollback(doc.features.findIndex((x) => x.id === id)).then(() => loadParts(s));
}

function leave() {
  batch(() => {
    setSession(null);
    setMode('part');
  });
  view.renderer?.invalidate();
  const held = heldBar;
  heldBar = null;
  return held ? returnBar(held) : Promise.resolve();
}

export async function finishSketch() {
  const s = session();
  if (!s) return;
  s.editing[1](null);
  const data = await s.settled();
  const before = documentText();
  const feature = { type: 'constrained_sketch', plane: s.placement ?? placementOf(s.plane), sketch: data };
  try {
    if (s.featureId === null) {
      if (!data.entities.length) return leave();
      const r = await mutate('feature_add', { feature, name: s.name, position: insertPosition() });
      const id = Number(/\(id (\d+)\)/.exec(r.text)?.[1]);
      if (id) {
        setSelectedFeature(id);
        savePlaces(id, s.places);
        await saveLinks(id, s.links);
      }
    } else if (s.canUndo[0]()) {
      await mutate('feature_edit', { id: s.featureId, feature });
    }
    if (s.featureId !== null) {
      await saveLinks(s.featureId, s.links);
      savePlaces(s.featureId, s.places);
      setSelectedFeature(s.featureId);
    }
    if (s.featureId === null || s.canUndo[0]()) pushUndo(before);
    await leave();
    if (s.featureId === null && !s.regions.length) toast('This sketch has no closed area yet, so it can’t be extruded.');
  } catch (e) {
    toast((e as ToolError).message, 'error');
  }
}

export function cancelSketch() {
  return leave();
}

/**
 * Which sketches show in the part view: any not yet used, and whichever is selected or picked from. Extruding some of a
 * sketch's regions doesn't use it up, so the rest stay there to pick until each has been used.
 */
/** The sketches a feature has used up, so they're out of sight unless shown, as Onshape hides a sketch once it's used. */
function usedSketches(): Set<number> {
  const last = doc.rollback ?? doc.features.length - 1;
  const used = new Set<number>();
  const picked = new Map<number, Set<string>>();
  const pick = (sketch: number, id: string) => {
    if (!picked.has(sketch)) picked.set(sketch, new Set());
    picked.get(sketch)!.add(id);
  };
  doc.features.forEach((f, i) => {
    if (i > last) return;
    if (Array.isArray(f.sections)) f.sections.forEach((x: any) => (typeof x === 'number' ? used.add(x) : x && pick(x.sketch, x.region)));
    if (Array.isArray(f.regions) && f.regions.length) {
      for (const r of f.regions) {
        if (typeof r === 'string') pick(f.sketch, r);
        else if (r && typeof r.sketch === 'number') pick(r.sketch, r.region);
      }
    } else if (typeof f.sketch === 'number') used.add(f.sketch);
    // A sweep's path is used up as its profile is.
    if (f.path && typeof f.path.sketch === 'number') used.add(f.path.sketch);
  });
  // Every region, holes too: a disc inside a ring is there to extrude until something has.
  for (const [id, ids] of picked) {
    if ((sketchRegions().get(id) ?? []).every((r) => ids.has(r.id))) used.add(id);
  }
  return used;
}

/** Sketches shown although they're used, and hidden although they aren't, by id, kept with the document. */
const idList = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []);
export const shownSketchIds = () => idList(doc.app?.sketches_shown);
export const hiddenSketchIds = () => idList(doc.app?.sketches_hidden);

/** Whether a sketch is on show, by its eye: used-up sketches are hidden until shown, and the rest shown until hidden. */
export function sketchShown(id: number) {
  return usedSketches().has(id) ? shownSketchIds().includes(id) : !hiddenSketchIds().includes(id);
}

/**
 * Shows or hides a sketch, as its eye in the list does. Seeing the model differently isn't a change to undo, so it takes
 * no undo step.
 */
export async function setSketchShown(id: number, shown: boolean) {
  const app = JSON.parse(JSON.stringify(doc.app ?? {}));
  const used = usedSketches().has(id);
  const live = (ids: number[]) => ids.filter((x) => doc.features.some((f) => f.id === x));
  let on = live(shownSketchIds()).filter((x) => x !== id);
  let off = live(hiddenSketchIds()).filter((x) => x !== id);
  if (used && shown) on = [...on, id];
  if (!used && !shown) off = [...off, id];
  if (on.length) app.sketches_shown = on.sort((a, b) => a - b);
  else delete app.sketches_shown;
  if (off.length) app.sketches_hidden = off.sort((a, b) => a - b);
  else delete app.sketches_hidden;
  await mutate('app_set', Object.keys(app).length ? { app } : {});
}

export function visibleSketches(alsoShow: (number | null | undefined)[] = []) {
  if (sketchesHidden()) return [];
  const last = doc.rollback ?? doc.features.length - 1;
  const used = usedSketches();
  const on = new Set(shownSketchIds());
  const off = new Set(hiddenSketchIds());
  const chosen = selectedFeature();
  const also = new Set(alsoShow.filter((x): x is number => typeof x === 'number'));
  const shown = (id: number) => (used.has(id) ? on.has(id) : !off.has(id));
  return doc.features.filter((f, i) => f.type === 'constrained_sketch' && !isHidden(f) && !f.suppressed && i <= last && (shown(f.id) || f.id === chosen || also.has(f.id)));
}

export { PLANES };
