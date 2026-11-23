import { segPoints, type SketchData, type V2 } from './geometry';

/** A text in a sketch: its words, set in the kernel's font, placed by two point entities, its baseline's start and a capital's height above it. */
export interface SketchText { id: number; at: number; up: number; text: string; font?: string }

/** Each text's curves from the sketch's arrangement, as pieces of line, by the text's id. */
export function textOutlinesOf(data: SketchData, regions: any[]): Map<number, V2[][]> {
  const ids = new Set(((data.texts ?? []) as SketchText[]).map((t) => t.id));
  const out = new Map<number, V2[][]>();
  if (!ids.size) return out;
  const seen = new Set<string>();
  for (const r of regions) {
    for (const loop of [r.outer, ...(r.holes ?? [])]) {
      for (const seg of loop) {
        if (!ids.has(seg.entity)) continue;
        const pts = segPoints(seg);
        if (pts.length < 2) continue;
        // Each piece bounds a letter and what's around it, so it comes twice, once each way.
        const a = pts[0], b = pts[pts.length - 1];
        const key = [a, b].map((p) => p.map((c) => c.toFixed(6)).join(',')).sort().join(';') + `;${pts.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.set(seg.entity, [...(out.get(seg.entity) ?? []), pts]);
      }
    }
  }
  return out;
}

