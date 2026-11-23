import { createSignal } from 'solid-js';
import type { V3 } from '../viewport/math';

/**
 * Onshape's section view: the model cut by a plane, Top, Front or Right or a flat face, moved along its normal, with
 * what's in front of it taken away. It's how you look, not a change to the part.
 */
export interface Section { by: 'top' | 'front' | 'right' | 'face'; point: V3; normal: V3; offset: number; flip: boolean; faceName?: string }
export const [section, setSection] = createSignal<Section | null>(null);

export const SECTION_PLANES: Record<'top' | 'front' | 'right', V3> = { top: [0, 0, 1], front: [0, -1, 0], right: [1, 0, 0] };

/** The plane the renderer cuts with: points beyond it, along its normal, go. */
export function clipPlane(s: Section): { normal: V3; offset: number } {
  const sign = s.flip ? -1 : 1;
  const n: V3 = [s.normal[0] * sign, s.normal[1] * sign, s.normal[2] * sign];
  const at: V3 = [s.point[0] + s.normal[0] * s.offset, s.point[1] + s.normal[1] * s.offset, s.point[2] + s.normal[2] * s.offset];
  return { normal: n, offset: n[0] * at[0] + n[1] * at[1] + n[2] * at[2] };
}
