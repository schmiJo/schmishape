import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { activeDef } from '../features/dialog';
import { measure, type MeasureRow } from '../features/measure';
import type { V3 } from '../viewport/math';
import { edgeList, faceList, mesh } from '../store/doc';
import { notStudio } from '../store/tabs';
import { mode, selectedPart, selection } from '../store/ui';

/** The line a measured distance runs along, for the view to draw. */
export const [measureLine, setMeasureLine] = createSignal<[V3, V3] | null>(null);

/** Onshape's measurements in the corner of the view, for the faces and edges selected. */
export function MeasureBox() {
  const [rows, setRows] = createSignal<MeasureRow[]>([]);
  createEffect(() => {
    const sel = selection();
    mesh();
    if (activeDef() || mode() !== 'part' || notStudio() || selectedPart() !== null || (!sel.faces.length && !sel.edges.length)) {
      setRows([]);
      setMeasureLine(null);
      return;
    }
    let live = true;
    onCleanup(() => { live = false; });
    void Promise.all([faceList(), edgeList()]).then(([faces, edges]) => {
      if (!live) return;
      const m = measure(sel.faces.map((i) => faces[i]).filter(Boolean), sel.edges.map((i) => edges[i]).filter(Boolean));
      setRows(m.rows);
      setMeasureLine(m.line);
    });
  });
  return (
    <Show when={rows().length}>
      <dl class="measure" data-testid="measure" aria-label="Measurements">
        <For each={rows()}>{(r) => <><dt>{r.label}</dt><dd>{r.value}</dd></>}</For>
      </dl>
    </Show>
  );
}
