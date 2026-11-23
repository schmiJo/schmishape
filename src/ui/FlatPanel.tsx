import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
import { command } from '../commands';
import { fmtNum, partLabel } from '../features/words';
import { mesh, partLooks } from '../store/doc';
import { flatBounds, flatLoops, litBend, setFlatBody, setFlatOpen, setLitBend, sheetParts, shownSheet, type FlatEdge, type FlatPattern, type P2 } from '../store/sheetmetal';
import { Icon } from './icons';

/** Screen y runs down, and the flat pattern's y up. */
const at = (p: P2) => `${p[0]} ${-p[1]}`;

/** One edge of a loop, carrying on from where the last one ended. */
function edgePath(e: FlatEdge): string {
  if ('line' in e) return `L${at(e.line[1])}`;
  if ('points' in e) return e.points.slice(1).map((p) => `L${at(p)}`).join('');
  const [a, b] = e.arc;
  const [cx, cy] = e.center;
  const r = e.radius;
  // Flipped upside down, an anticlockwise arc is drawn clockwise.
  const sweep = e.ccw ? 0 : 1;
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) {
    const far: P2 = [2 * cx - a[0], 2 * cy - a[1]];
    return `A${r} ${r} 0 0 ${sweep} ${at(far)}A${r} ${r} 0 0 ${sweep} ${at(b)}`;
  }
  let span = Math.atan2(b[1] - cy, b[0] - cx) - Math.atan2(a[1] - cy, a[0] - cx);
  if (e.ccw && span <= 0) span += 2 * Math.PI;
  if (!e.ccw && span >= 0) span -= 2 * Math.PI;
  return `A${r} ${r} 0 ${Math.abs(span) > Math.PI ? 1 : 0} ${sweep} ${at(b)}`;
}

const start = (e: FlatEdge): P2 => ('line' in e ? e.line[0] : 'arc' in e ? e.arc[0] : e.points[0]);

/** The outside and its holes as one shape, so the holes show through. */
function outlinePath(flat: FlatPattern): string {
  return flatLoops(flat.outline).map((loop) => `M${at(start(loop[0]))}${loop.map(edgePath).join('')}Z`).join('');
}

/**
 * The flat pattern drawn to fit, its bend lines dashed: long dashes bend up, dots and dashes down. Scroll zooms about the
 * pointer, dragging pans, and a double-click fits it again, as the model's view does.
 */
function Drawing(props: { flat: FlatPattern }) {
  const fitted = createMemo(() => {
    const { min, max } = flatBounds(props.flat);
    const pad = Math.max(max[0] - min[0], max[1] - min[1], 1) * 0.06;
    return [min[0] - pad, -max[1] - pad, max[0] - min[0] + 2 * pad, max[1] - min[1] + 2 * pad] as [number, number, number, number];
  });
  const [box, setBox] = createSignal(fitted());
  // A different part, or a change that moves the outline, fits it again.
  createEffect(on(fitted, (f) => setBox(f)));
  let svg!: SVGSVGElement;
  /** A bend's note, beside its line and along it, sized to the drawing, never upside down. */
  const note = (line: [P2, P2]) => {
    const [a, b] = line;
    let angle = (Math.atan2(-(b[1] - a[1]), b[0] - a[0]) * 180) / Math.PI;
    if (angle > 90) angle -= 180;
    if (angle <= -90) angle += 180;
    const size = Math.max(fitted()[2], fitted()[3]) / 34;
    const t = (angle * Math.PI) / 180;
    const x = (a[0] + b[0]) / 2 + Math.sin(t) * size * 0.4, y = -(a[1] + b[1]) / 2 - Math.cos(t) * size * 0.4;
    return { x, y, 'font-size': String(size), transform: `rotate(${angle} ${x} ${y})`, 'text-anchor': 'middle' as const };
  };
  const toDrawing = (x: number, y: number) => {
    const m = svg.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(x, y).matrixTransform(m.inverse());
    return [p.x, p.y];
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const k = Math.exp(e.deltaY * 0.0015);
    const [px, py] = toDrawing(e.clientX, e.clientY);
    const [x, y, w, h] = box();
    setBox([px - (px - x) * k, py - (py - y) * k, w * k, h * k]);
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    svg.setPointerCapture(e.pointerId);
    let [lx, ly] = toDrawing(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => {
      const [px, py] = toDrawing(ev.clientX, ev.clientY);
      const [x, y, w, h] = box();
      setBox([x - (px - lx), y - (py - ly), w, h]);
      [lx, ly] = toDrawing(ev.clientX, ev.clientY);
    };
    const up = () => { svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up); };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
  };
  return (
    <svg
      ref={svg}
      class="flat-svg"
      viewBox={box().join(' ')}
      preserveAspectRatio="xMidYMid meet"
      data-testid="flat-drawing"
      onPointerLeave={() => setLitBend(null)}
      onWheel={onWheel}
      onPointerDown={onDown}
      onDblClick={() => setBox(fitted())}
    >
      <path class="flat-sheet" d={outlinePath(props.flat)} fill-rule="evenodd" vector-effect="non-scaling-stroke" />
      <For each={props.flat.bends}>
        {(b, i) => (
          <g class="flat-bend" classList={{ lit: litBend() === i(), down: b.direction === 'down' }} data-bend={i()} onPointerEnter={() => setLitBend(i())}>
            <line class="flat-bend-line" x1={b.line[0][0]} y1={-b.line[0][1]} x2={b.line[1][0]} y2={-b.line[1][1]} vector-effect="non-scaling-stroke" />
            <line class="flat-bend-hit" x1={b.line[0][0]} y1={-b.line[0][1]} x2={b.line[1][0]} y2={-b.line[1][1]} vector-effect="non-scaling-stroke" />
            <text class="flat-bend-note" {...note(b.line)}>{b.direction === 'up' ? 'UP' : 'DOWN'} {fmtNum(b.degrees)}° R{fmtNum(b.radius)}</text>
          </g>
        )}
      </For>
    </svg>
  );
}

/**
 * Onshape's flat view and sheet metal table, beside the model: the part laid out flat, its size, and a row for each
 * bend. It follows the rollback bar, and a dialog's preview, as the model does.
 */
export function FlatPanel() {
  const parts = () => mesh()?.parts ?? [];
  const label = (body: string) => partLabel(parts(), body, partLooks());
  const sheet = shownSheet;
  return (
    <section class="flat-panel" aria-label="Flat pattern" data-testid="flat-panel">
      <header class="flat-head">
        <h2>Flat pattern</h2>
        <button class="mini" aria-label="Export as DXF" data-tip="Export as DXF" disabled={!sheet()?.flat} onClick={() => void command('export.dxf').run()} data-testid="flat-dxf">
          <Icon name="download" />
        </button>
        <button class="mini" aria-label="Close the flat pattern" data-tip="Close" onClick={() => setFlatOpen(false)}>
          <Icon name="close" />
        </button>
      </header>
      <Show when={sheetParts().length > 1}>
        <label class="flat-part">
          <span class="field-label">Part</span>
          <select class="select" data-testid="flat-part" value={sheet()?.body ?? ''} onChange={(e) => { setLitBend(null); setFlatBody(e.currentTarget.value); }}>
            <For each={sheetParts()}>{(p) => <option value={p.body} selected={p.body === sheet()?.body}>{label(p.body)}</option>}</For>
          </select>
        </label>
      </Show>
      <Show
        when={sheet()}
        fallback={<p class="flat-empty" data-testid="flat-empty">No sheet metal part here. Make one with Sheet metal model, or move the rollback bar down past one.</p>}
      >
        {(part) => (
          <Show when={part().flat} fallback={<p class="flat-empty flat-error" data-testid="flat-error">{part().error}</p>}>
            {(flat) => (
              <>
                <div class="flat-view"><Drawing flat={flat()} /></div>
                <dl class="flat-facts" data-testid="flat-facts">
                  <dt>Size</dt><dd data-fact="size">{fmtNum(flat().size[0])} × {fmtNum(flat().size[1])} mm</dd>
                  <dt>Area</dt><dd data-fact="area">{fmtNum(flat().area)} mm²</dd>
                  <dt>Thickness</dt><dd data-fact="thickness">{fmtNum(flat().thickness)} mm</dd>
                  <dt>K factor</dt><dd data-fact="k">{fmtNum(flat().k_factor)}</dd>
                </dl>
                <h3 class="flat-subhead">Bends</h3>
                <Show when={flat().bends.length} fallback={<p class="flat-empty">None. Add a flange to bend it.</p>}>
                  <table class="flat-table" data-testid="flat-table" onPointerLeave={() => setLitBend(null)}>
                    <thead><tr><th>Bend</th><th>Direction</th><th>Angle</th><th>Radius</th><th title="How long the bend is laid out flat">Allowance</th></tr></thead>
                    <tbody>
                      <For each={flat().bends}>
                        {(b, i) => (
                          <tr classList={{ lit: litBend() === i() }} data-bend={i()} onPointerEnter={() => setLitBend(i())}>
                            <td>Bend {i() + 1}</td>
                            <td>{b.direction === 'up' ? 'Up' : 'Down'}</td>
                            <td>{fmtNum(b.degrees)}°</td>
                            <td>{fmtNum(b.radius)} mm</td>
                            <td>{fmtNum(b.width)} mm</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                  <p class="flat-key"><span class="key-up" />Up <span class="key-down" />Down</p>
                </Show>
              </>
            )}
          </Show>
        )}
      </Show>
    </section>
  );
}
