import { planeFromPlacement, type Plane } from '../sketch/geometry';
import { doc, mutate, type PlaneInfo } from './doc';
import { geometryHidden, setDefaultPlanesHidden } from './ui';

/** Top, Front and Right as the kernel names them, in the order of their rows: Top is plane 1. */
export const DEFAULT_PLANES = ['top', 'front', 'right'] as const;
export type DefaultPlane = (typeof DEFAULT_PLANES)[number];

/**
 * Planes are drawn and picked by number: Top, Front and Right are 1 to 3, as they always were, and a plane feature is
 * this plus its id, so the two never meet.
 */
export const FEATURE_QUAD = 1000;

export const frameOfInfo = (p: PlaneInfo | undefined): Plane | null =>
  p?.origin && p.normal && p.x && p.y ? { origin: p.origin, x: p.x, y: p.y, z: p.normal } : null;

/** Where a sketch lies: as the kernel works it out, following the plane or face it's on, or else as its file says. */
export function sketchPlane(f: any): Plane {
  return frameOfInfo(doc.planes.find((p) => p.id === f.id)) ?? planeFromPlacement(f.plane, doc.env);
}

export const isPlaneFeature = (f: { type?: string } | undefined) => f?.type === 'plane';

/** A plane feature where it is now, or null while it's rolled back, turned off or failed. */
export const planeFrame = (id: number) => frameOfInfo(doc.planes.find((p) => p.id === id && p.type === 'plane'));

/** The quad a plane reference is drawn as, if it names a plane rather than a face. */
export function quadOfRef(ref: unknown): number | null {
  if (typeof ref === 'number') return FEATURE_QUAD + ref;
  const i = DEFAULT_PLANES.indexOf(ref as DefaultPlane);
  return i >= 0 ? i + 1 : null;
}
export const refOfQuad = (quad: number): DefaultPlane | number => (quad >= FEATURE_QUAD ? quad - FEATURE_QUAD : DEFAULT_PLANES[quad - 1]);

/**
 * A plane given as a point and a normal, as older mirrors and trims were written, by the default plane it is if it's
 * one of them. With `signed`, only one facing the same way counts, for a trim or draft where the side matters.
 */
export function planeFromNumbers(normal: unknown, point: unknown, signed: boolean): unknown {
  const n = Array.isArray(normal) && normal.every((c) => typeof c === 'number') ? (normal as number[]) : [0, 0, 1];
  const p = Array.isArray(point) ? point : [0, 0, 0];
  const atOrigin = p.every((c) => c === 0);
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const u = n.map((c) => c / len);
  const facing: [DefaultPlane, number[]][] = [['top', [0, 0, 1]], ['front', [0, -1, 0]], ['right', [1, 0, 0]]];
  for (const [name, d] of facing) {
    const along = u[0] * d[0] + u[1] * d[1] + u[2] * d[2];
    if (atOrigin && (along > 1 - 1e-9 || (!signed && along < -1 + 1e-9))) return name;
  }
  return { point: p, normal: n };
}

/** Which plane features are hidden. It's kept with the document, as Onshape keeps it, by feature id. */
export const hiddenPlanes = (): number[] => (Array.isArray(doc.app?.hidden_planes) ? doc.app.hidden_planes : []);

/**
 * Shows or hides plane features. Seeing the model differently isn't a change to undo, so this takes no undo step,
 * though undoing something else can bring back how it was then.
 */
export async function setPlanesHidden(ids: number[], hidden: boolean) {
  const app = JSON.parse(JSON.stringify(doc.app ?? {}));
  const now = new Set<number>(hiddenPlanes());
  for (const id of ids) {
    if (hidden) now.add(id);
    else now.delete(id);
  }
  const live = [...now].filter((id) => doc.features.some((f) => f.id === id));
  if (live.length) app.hidden_planes = live.sort((a, b) => a - b);
  else delete app.hidden_planes;
  await mutate('app_set', Object.keys(app).length ? { app } : {});
}

/** Hides every plane, Top, Front and Right and the plane features, or shows them all if none is on show. */
export async function togglePlanes() {
  const features = doc.features.filter(isPlaneFeature).map((f) => f.id as number);
  const off = new Set(hiddenPlanes());
  const anyShown = [1, 2, 3].some((p) => !geometryHidden().has(p)) || features.some((id) => !off.has(id));
  setDefaultPlanesHidden(anyShown);
  if (features.length) await setPlanesHidden(features, anyShown);
}
