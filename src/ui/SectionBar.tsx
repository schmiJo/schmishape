import { createEffect, createMemo, For, Show } from 'solid-js';
import { fmtNum } from '../features/words';
import { mesh } from '../store/doc';
import { clipPlane, section, SECTION_PLANES, setSection } from '../store/section';
import { view } from '../viewport/instance';
import type { V3 } from '../viewport/math';
import { Icon } from './icons';

const WORDS = { top: 'Top', front: 'Front', right: 'Right', face: 'Face' } as const;

/** The section view's bar, across the top of the view: what cuts, how far along, and which side stays. */
export function SectionBar() {
  // The model's extent along the cut's normal, for the slider.
  const range = createMemo(() => {
    const s = section();
    const m = mesh();
    if (!s || !m || !m.indices.length) return { lo: -50, hi: 50 };
    let lo = Infinity, hi = -Infinity;
    for (const x of [m.min[0], m.max[0]]) for (const y of [m.min[1], m.max[1]]) for (const z of [m.min[2], m.max[2]]) {
      const d = (x - s.point[0]) * s.normal[0] + (y - s.point[1]) * s.normal[1] + (z - s.point[2]) * s.normal[2];
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    return { lo: Math.floor(lo), hi: Math.ceil(hi) };
  });
  createEffect(() => {
    const s = section();
    const r = view.renderer;
    if (!r) return;
    r.section = s ? clipPlane(s) : null;
    r.invalidate();
  });
  const set = (patch: Partial<NonNullable<ReturnType<typeof section>>>) => {
    const s = section();
    if (s) setSection({ ...s, ...patch });
  };
  const choose = (by: 'top' | 'front' | 'right') => set({ by, point: [0, 0, 0] as V3, normal: SECTION_PLANES[by], offset: 0, faceName: undefined });
  return (
    <Show when={section()}>
      {(s) => (
        <div class="section-bar" role="toolbar" aria-label="Section view" data-testid="section-bar">
          <span class="section-title">Section</span>
          <div class="segment" aria-label="Section plane">
            <For each={['top', 'front', 'right'] as const}>{(by) => <button classList={{ on: s().by === by }} onClick={() => choose(by)}>{WORDS[by]}</button>}</For>
            <Show when={s().by === 'face'}><button class="on" data-tip={s().faceName}>Face</button></Show>
          </div>
          <input
            class="section-slider"
            type="range"
            aria-label="Section offset"
            min={range().lo}
            max={range().hi}
            step={Math.max(0.1, (range().hi - range().lo) / 400)}
            value={s().offset}
            onInput={(e) => set({ offset: Number(e.currentTarget.value) })}
          />
          <label class="section-offset">
            <input
              value={fmtNum(s().offset)}
              aria-label="Offset in mm"
              data-testid="section-offset"
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }}
              onChange={(e) => { const v = Number(e.currentTarget.value.replace(/,/g, '')); if (Number.isFinite(v)) set({ offset: v }); }}
            />
            <span class="unit">mm</span>
          </label>
          <button class="field-flip" classList={{ on: s().flip }} aria-pressed={s().flip} aria-label="Keep the other side" data-tip="Keep the other side" onClick={() => set({ flip: !s().flip })}><Icon name="flip" /></button>
          <button class="mini" aria-label="Close the section view" data-tip="Close" onClick={() => setSection(null)}><Icon name="close" /></button>
        </div>
      )}
    </Show>
  );
}
