import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { loadStudio } from '../assembly/parts';
import { tabById, tabDocumentText, tabs } from '../store/tabs';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { DialogFrame } from '../ui/DialogFrame';
import { Icon } from '../ui/icons';
import type { V3 } from '../viewport/math';
import {
  addDimension, addSection, addView, changeDrawing, drawingBusy, drawingData, drawingError, drawingForm, exportDrawing, nextLetter, removeItem,
  rendered, SCALES, setDrawingForm, SHEETS, sketchPoints, sourceBounds, sourceName, TITLE_FIELDS, VIEW_NAMES, type DrawingDim, type DrawingFormat,
  type DrawingView, type Spot, type TitleField, type ViewType,
} from './store';
import './drawing.css';

type Menu = { x: number; y: number; items: (MenuItem | null)[] };
const keep = (e: KeyboardEvent) => e.stopPropagation();
const TITLE_LABELS: Record<TitleField, string> = { title: 'Title', number: 'Drawing number', part: 'Part', material: 'Material', author: 'Drawn by', date: 'Date', company: 'Company', revision: 'Revision' };
const PLAIN_VIEWS: Exclude<ViewType, 'section'>[] = ['front', 'top', 'right', 'back', 'bottom', 'left', 'iso'];

function viewLabel(v: DrawingView) {
  return v.type === 'section' ? `Section ${v.letter ?? ''}-${v.letter ?? ''}` : VIEW_NAMES[v.type];
}

function spotLabel(s: Spot | undefined) {
  if (!s) return '';
  if (Array.isArray(s)) return `(${s.map((x) => Number(x.toFixed(2))).join(', ')})`;
  const named = sketchPoints(drawingData()?.source).find((p) => p.spot.sketch === s.sketch && p.spot.point === s.point);
  return named?.label ?? `Sketch ${s.sketch} · point ${s.point}`;
}

function dimLabel(d: DrawingDim) {
  const view = drawingData()?.drawing.views.find((v) => v.id === d.view);
  const where = view ? ` · ${viewLabel(view)}` : '';
  if (d.type === 'distance') return `Distance ${spotLabel(d.a)} to ${spotLabel(d.b)}${where}`;
  return `${d.type === 'diameter' ? 'Diameter' : 'Radius'} near ${spotLabel(d.near)}${where}`;
}

/** The sidebar of a Drawing tab: what it shows, its sheet, its views and dimensions, and its title block. */
export function DrawingPanels() {
  const d = () => drawingData();
  const [titleOpen, setTitleOpen] = createSignal(false);
  const [menu, setMenu] = createSignal<Menu | null>(null);
  const sources = () => tabs().filter((t) => t.kind === 'part-studio' || t.kind === 'assembly');
  const [parts] = createResource(
    () => { const s = d()?.source; return s && tabById(s.tab)?.kind === 'part-studio' ? { tab: s.tab, text: tabDocumentText(s.tab) } : null; },
    (k) => loadStudio(k.tab, k.text),
  );
  const setSource = (tab: string, body: string | null) => void changeDrawing((x) => {
    x.source = { tab, body };
  }, true).then(async () => {
    const part = await sourceName({ tab, body });
    void changeDrawing((x) => { x.drawing.title.part = part; }, true);
  });
  const rowMenu = (e: MouseEvent, id: number) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items: [{ label: 'Delete', danger: true, run: () => removeItem(id) }] });
  };
  return (
    <Show when={d()}>
      {(data) => (
        <>
          <section class="panel drawing-panel" aria-label="Drawing" data-testid="drawing-panel">
            <h2>Drawing</h2>
            <div class="drawing-fields">
              <label class="drawing-field">
                <span>Source</span>
                <select class="select" data-testid="drawing-source" value={data().source.tab} onChange={(e) => setSource(e.currentTarget.value, null)}>
                  <Show when={!tabById(data().source.tab)}><option value={data().source.tab} selected>(deleted tab)</option></Show>
                  <For each={sources()}>{(t) => <option value={t.id} selected={t.id === data().source.tab}>{t.name}</option>}</For>
                </select>
              </label>
              <Show when={tabById(data().source.tab)?.kind === 'part-studio'}>
                <label class="drawing-field">
                  <span>Part</span>
                  <select class="select" data-testid="drawing-part" value={data().source.body ?? ''} onChange={(e) => setSource(data().source.tab, e.currentTarget.value || null)}>
                    <option value="" selected={!data().source.body}>All parts</option>
                    <For each={parts()?.parts ?? []}>{(p) => <option value={p.body} selected={p.body === data().source.body}>{p.label}</option>}</For>
                  </select>
                </label>
              </Show>
              <label class="drawing-field">
                <span>Sheet</span>
                <select class="select" data-testid="drawing-sheet-size" value={data().drawing.sheet} onChange={(e) => { const v = e.currentTarget.value; void changeDrawing((x) => { x.drawing.sheet = v; }); }}>
                  <For each={SHEETS}>{(s) => <option value={s} selected={s === data().drawing.sheet}>{s}</option>}</For>
                </select>
              </label>
              <div class="drawing-field">
                <span>Projection</span>
                <div class="segment" role="radiogroup" aria-label="Projection" data-testid="drawing-projection">
                  <button classList={{ on: data().drawing.projection === 'first_angle' }} role="radio" aria-checked={data().drawing.projection === 'first_angle'} data-tip="First angle, as in Europe: the top view goes below the front" onClick={() => void changeDrawing((x) => { x.drawing.projection = 'first_angle'; })}>First</button>
                  <button classList={{ on: data().drawing.projection === 'third_angle' }} role="radio" aria-checked={data().drawing.projection === 'third_angle'} data-tip="Third angle, as in America: the top view goes above the front" onClick={() => void changeDrawing((x) => { x.drawing.projection = 'third_angle'; })}>Third</button>
                </div>
              </div>
              <label class="drawing-field">
                <span>Scale</span>
                <select class="select" data-testid="drawing-scale" onChange={(e) => { const v = e.currentTarget.value; void changeDrawing((x) => { x.drawing.scale = v ? Number(v) : null; }); }}>
                  <option value="" selected={!data().drawing.scale}>Fit{!data().drawing.scale && rendered() ? ` (${rendered()!.scale})` : ''}</option>
                  <For each={SCALES}>{([label, v]) => <option value={v} selected={data().drawing.scale === v}>{label}</option>}</For>
                </select>
              </label>
              <label class="check">
                <input type="checkbox" data-testid="drawing-auto" checked={data().drawing.auto_dimensions} onChange={(e) => { const v = e.currentTarget.checked; void changeDrawing((x) => { x.drawing.auto_dimensions = v; }); }} />
                Overall sizes and hole diameters
              </label>
            </div>
          </section>
          <section class="panel" aria-label="Views">
            <h2>Views ({data().drawing.views.length})</h2>
            <div class="parts-list" data-testid="drawing-views">
              <For each={data().drawing.views}>
                {(v) => (
                  <div class="feature-row drawing-row" data-view={v.id} onContextMenu={(e) => rowMenu(e, v.id)}>
                    <Icon name={v.type === 'section' ? 'section-view' : v.type === 'iso' ? 'iso' : 'drawing'} />
                    <span class="feature-name">{viewLabel(v)}</span>
                    <Show when={v.type !== 'iso' && v.type !== 'section'}>
                      <button class="row-more" classList={{ held: v.hidden !== false }} aria-label={`Hidden lines in ${viewLabel(v)}`} aria-pressed={v.hidden !== false} data-tip={v.hidden === false ? 'Show hidden lines' : 'Hide hidden lines'} onClick={() => void changeDrawing((x) => { const w = x.drawing.views.find((y) => y.id === v.id); if (w) w.hidden = v.hidden === false; })}><Icon name={v.hidden === false ? 'eye-off' : 'eye'} size={13} /></button>
                    </Show>
                    <button class="row-more" aria-label={`Delete ${viewLabel(v)}`} data-tip="Delete" onClick={() => removeItem(v.id)}><Icon name="minus" size={13} /></button>
                  </div>
                )}
              </For>
            </div>
          </section>
          <section class="panel" aria-label="Dimensions">
            <h2>Dimensions ({data().drawing.dimensions.length})</h2>
            <div class="parts-list" data-testid="drawing-dimensions">
              <Show when={!data().drawing.dimensions.length}><p class="panel-empty">{data().drawing.auto_dimensions ? 'Only the automatic ones. ' : ''}Add one with Dimension above the sheet.</p></Show>
              <For each={data().drawing.dimensions}>
                {(m) => (
                  <div class="feature-row drawing-row" data-dimension={m.id} onContextMenu={(e) => rowMenu(e, m.id)}>
                    <Icon name="dimension" />
                    <span class="feature-name" data-tip={dimLabel(m)}>{m.text ? m.text.replace('<>', '…') : dimLabel(m)}</span>
                    <button class="row-more" aria-label="Delete dimension" data-tip="Delete" onClick={() => removeItem(m.id)}><Icon name="minus" size={13} /></button>
                  </div>
                )}
              </For>
            </div>
          </section>
          <section class="panel" aria-label="Title block">
            <h2>
              Title block
              <span class="panel-tools"><button class="mini" aria-label={titleOpen() ? 'Hide title block' : 'Edit title block'} data-testid="drawing-title-toggle" onClick={() => setTitleOpen(!titleOpen())}><Icon name="caret" size={13} /></button></span>
            </h2>
            <Show when={titleOpen()}>
              <div class="drawing-fields">
                <For each={TITLE_FIELDS}>
                  {(k) => (
                    <label class="drawing-field">
                      <span>{TITLE_LABELS[k]}</span>
                      <input class="drawing-input" data-title-field={k} value={data().drawing.title[k] ?? ''} onKeyDown={(e) => { keep(e); if (e.key === 'Enter') e.currentTarget.blur(); }} onChange={(e) => { const v = e.currentTarget.value.trim(); void changeDrawing((x) => { if (v) x.drawing.title[k] = v; else delete x.drawing.title[k]; }); }} />
                    </label>
                  )}
                </For>
              </div>
            </Show>
          </section>
          <Show when={menu()}>{(m) => <ContextMenu {...m()} close={() => setMenu(null)} />}</Show>
        </>
      )}
    </Show>
  );
}

/** The drawing's tools, in the top bar. */
export function DrawingTools() {
  const [menu, setMenu] = createSignal<Menu | null>(null);
  const open = (e: MouseEvent, items: (MenuItem | null)[]) => {
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: b.left, y: b.bottom + 2, items });
  };
  const views = (e: MouseEvent) => open(e, PLAIN_VIEWS.map((t) => ({ label: `${VIEW_NAMES[t]} view`, command: `drawing.view.${t}`, run: () => void addView(t) })));
  const exports = (e: MouseEvent) => open(e, (['pdf', 'svg', 'dxf', 'png'] as DrawingFormat[]).map((f) => ({ label: `Export ${f.toUpperCase()}`, command: `drawing.export.${f}`, run: () => void exportDrawing(f) })));
  return (
    <div class="tools" role="toolbar" aria-label="Drawing sheet tools">
      <div class="tool-group">
        <button class="tool" aria-label="Insert view" aria-haspopup="menu" data-tip="Insert view" data-testid="drawing-insert-view" onClick={views}><Icon name="insert" /></button>
        <button class="tool" classList={{ on: drawingForm() === 'section' }} aria-label="Section view" data-tip="Section view" data-testid="drawing-section" onClick={() => setDrawingForm(drawingForm() === 'section' ? null : 'section')}><Icon name="section-view" /></button>
        <button class="tool" classList={{ on: drawingForm() === 'dimension' }} aria-label="Dimension" data-tip="Dimension" data-testid="drawing-dimension" onClick={() => setDrawingForm(drawingForm() === 'dimension' ? null : 'dimension')}><Icon name="dimension" /></button>
      </div>
      <div class="tool-group">
        <button class="tool" aria-label="Export" aria-haspopup="menu" data-tip="Export" data-testid="drawing-export" onClick={exports}><Icon name="download" /></button>
      </div>
      <Show when={menu()}>{(m) => <ContextMenu {...m()} close={() => setMenu(null)} />}</Show>
    </div>
  );
}

/** The sheet, over the 3D view: zoom with the wheel, drag to move it, double-click to fit. */
export function DrawingSheet() {
  let el!: HTMLDivElement;
  const [zoom, setZoom] = createSignal(0);
  const [pan, setPan] = createSignal<[number, number]>([0, 0]);
  const fit = () => {
    const r = rendered();
    if (!r || !el) return;
    const z = Math.min((el.clientWidth - 32) / r.width, (el.clientHeight - 32) / r.height);
    setZoom(Math.max(z, 0.05));
    setPan([(el.clientWidth - r.width * z) / 2, (el.clientHeight - r.height * z) / 2]);
  };
  // Fits when a sheet first shows, and when its size changes.
  let fitted = '';
  createEffect(() => {
    const r = rendered();
    const key = r ? `${r.width}x${r.height}` : '';
    if (r && key !== fitted) {
      fitted = key;
      queueMicrotask(fit);
    }
  });
  onMount(() => {
    const ro = new ResizeObserver(() => { if (fitted) fit(); });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const b = el.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
    const z0 = zoom(), z = Math.min(Math.max(z0 * Math.exp(-e.deltaY * 0.0015), 0.05), 40);
    const [px, py] = pan();
    setPan([x - ((x - px) * z) / z0, y - ((y - py) * z) / z0]);
    setZoom(z);
  };
  const down = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('.dialog')) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const [x0, y0] = [e.clientX, e.clientY], [p0, q0] = pan();
    const move = (ev: PointerEvent) => setPan([p0 + ev.clientX - x0, q0 + ev.clientY - y0]);
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.classList.remove('panning'); };
    el.classList.add('panning');
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <div class="drawing-stage" ref={el} data-testid="drawing-stage" onWheel={wheel} onPointerDown={down} onDblClick={fit} onContextMenu={(e) => e.preventDefault()}>
      <Show when={rendered()}>
        {(r) => (
          <img
            class="drawing-sheet"
            classList={{ stale: drawingBusy() }}
            src={r().url}
            alt="Drawing sheet"
            draggable={false}
            data-testid="drawing-sheet"
            data-scale={r().scale}
            style={{ left: `${pan()[0]}px`, top: `${pan()[1]}px`, width: `${r().width * zoom()}px`, height: `${r().height * zoom()}px` }}
          />
        )}
      </Show>
      <Show when={drawingError()}>{(why) => <div class="drawing-problem" role="alert" data-testid="drawing-error">{why()}</div>}</Show>
      <Show when={!drawingError() && rendered()?.notes.length}>
        <div class="drawing-notes" data-testid="drawing-notes">
          <For each={rendered()!.notes}>{(n) => <p><Icon name="warn" size={13} /> {n}</p>}</For>
        </div>
      </Show>
      <Show when={drawingBusy() && !rendered()}><div class="drawing-wait">Drawing…</div></Show>
      <div class="drawing-zoom">
        <button class="mini" aria-label="Fit sheet" data-tip="Fit sheet" data-keys="Double-click" onClick={fit}><Icon name="fit" size={14} /></button>
      </div>
      <Show when={drawingForm() === 'section'}><SectionForm /></Show>
      <Show when={drawingForm() === 'dimension'}><DimensionForm /></Show>
    </div>
  );
}

const AXES = { front: { label: 'Front', normal: [0, -1, 0] as V3, k: 1 }, top: { label: 'Top', normal: [0, 0, 1] as V3, k: 2 }, right: { label: 'Right', normal: [1, 0, 0] as V3, k: 0 } };
type Axis = keyof typeof AXES;

/** A section: parallel to one of the three planes, at a distance along its normal, cut away on one side. */
function SectionForm() {
  const [axis, setAxis] = createSignal<Axis>('front');
  const [offset, setOffset] = createSignal('0');
  const [flip, setFlip] = createSignal(false);
  const [letter, setLetter] = createSignal(nextLetter(drawingData()));
  const [bounds] = createResource(() => drawingData()?.source, sourceBounds);
  // Through the middle of the part, until a place is typed.
  let typed = false;
  createEffect(() => {
    const b = bounds(), k = AXES[axis()].k;
    if (b && !typed) setOffset(String(Number(((b.min[k] + b.max[k]) / 2).toFixed(3))));
  });
  const add = async () => {
    const v = Number(offset());
    if (!Number.isFinite(v)) return;
    const a = AXES[axis()];
    const point: V3 = [0, 0, 0];
    point[a.k] = v;
    const normal = a.normal.map((x) => (flip() ? -x : x) || 0) as V3;
    if (await addSection(point, normal, letter().trim().toUpperCase() || 'A')) setDrawingForm(null);
  };
  return (
    <DialogFrame
      label="Section view"
      testid="section-form"
      icon="section-view"
      title="Section view"
      actions={
        <>
          <button class="dialog-action ok" aria-label="Add section" data-tip="Add section" data-keys="Enter" data-testid="section-ok" onClick={() => void add()}><Icon name="check" /></button>
          <button class="dialog-action" aria-label="Cancel" data-tip="Cancel" data-keys="Esc" onClick={() => setDrawingForm(null)}><Icon name="close" /></button>
        </>
      }
    >
      <div class="field">
        <span class="field-label">Parallel to</span>
        <div class="segment" role="radiogroup" aria-label="Section plane">
          <For each={Object.keys(AXES) as Axis[]}>{(k) => <button classList={{ on: axis() === k }} role="radio" aria-checked={axis() === k} data-section-axis={k} onClick={() => { typed = false; setAxis(k); }}>{AXES[k].label}</button>}</For>
        </div>
      </div>
      <label class="field">
        <span class="field-label">At</span>
        <span class="field-control">
          <span class="field-input"><input data-testid="section-offset" value={offset()} onInput={(e) => { typed = true; setOffset(e.currentTarget.value); }} onKeyDown={(e) => { keep(e); if (e.key === 'Enter') void add(); }} /></span>
          <button class="field-flip" classList={{ on: flip() }} aria-label="Look from the other side" data-tip="Look from the other side" aria-pressed={flip()} data-testid="section-flip" onClick={() => setFlip(!flip())}><Icon name="flip" size={14} /></button>
        </span>
      </label>
      <label class="field">
        <span class="field-label">Letter</span>
        <span class="field-input"><input data-testid="section-letter" value={letter()} maxLength={2} onInput={(e) => setLetter(e.currentTarget.value)} onKeyDown={(e) => { keep(e); if (e.key === 'Enter') void add(); }} /></span>
      </label>
      <p class="field-hint">Cuts the part {AXES[axis()].label === 'Top' ? 'level' : 'upright'} at that distance along the {['x', 'y', 'z'][AXES[axis()].k]} axis, and looks at what's left from the side taken away.</p>
    </DialogFrame>
  );
}

/** A point for a dimension: one of the sketch points, which follows the model, or a place typed in. */
function SpotField(props: { label: string; value: Spot | null; set: (s: Spot | null) => void; testid: string }) {
  const points = createMemo(() => sketchPoints(drawingData()?.source));
  const typedValue = () => (Array.isArray(props.value) ? props.value : null);
  const [text, setText] = createSignal(typedValue()?.join(', ') ?? '');
  const pick = (v: string) => {
    if (v === 'typed') {
      const nums = text().split(/[\s,;]+/).filter(Boolean).map(Number);
      props.set(nums.length === 3 && nums.every(Number.isFinite) ? (nums as V3) : [0, 0, 0]);
      if (nums.length !== 3) setText('0, 0, 0');
      return;
    }
    const p = points()[Number(v)];
    props.set(p ? p.spot : null);
  };
  const chosen = () => {
    const v = props.value;
    if (!v) return '';
    if (Array.isArray(v)) return 'typed';
    const i = points().findIndex((p) => p.spot.sketch === v.sketch && p.spot.point === v.point);
    return i >= 0 ? String(i) : '';
  };
  return (
    <>
      <label class="field">
        <span class="field-label">{props.label}</span>
        <select class="select" data-testid={props.testid} onChange={(e) => pick(e.currentTarget.value)}>
          <option value="" selected={chosen() === ''}>Choose a point</option>
          <For each={points()}>{(p, i) => <option value={String(i())} selected={chosen() === String(i())}>{p.label}</option>}</For>
          <option value="typed" selected={chosen() === 'typed'}>A place, x y z…</option>
        </select>
      </label>
      <Show when={chosen() === 'typed'}>
        <label class="field">
          <span class="field-label" />
          <span class="field-input"><input data-testid={`${props.testid}-xyz`} value={text()} aria-label={`${props.label} x, y, z`} onInput={(e) => setText(e.currentTarget.value)} onChange={() => pick('typed')} onKeyDown={keep} /></span>
        </label>
      </Show>
    </>
  );
}

function DimensionForm() {
  const views = () => drawingData()?.drawing.views.filter((v) => v.type !== 'iso') ?? [];
  const [view, setView] = createSignal(views()[0]?.id ?? 0);
  const [type, setType] = createSignal<DrawingDim['type']>('distance');
  const [a, setA] = createSignal<Spot | null>(null);
  const [b, setB] = createSignal<Spot | null>(null);
  const [along, setAlong] = createSignal<'horizontal' | 'vertical' | 'aligned'>('horizontal');
  const [offset, setOffset] = createSignal('10');
  const [label, setLabel] = createSignal('');
  const ready = () => !!view() && (type() === 'distance' ? !!a() && !!b() : !!a());
  const add = async () => {
    if (!ready()) return;
    const off = Number(offset());
    const dim: Omit<DrawingDim, 'id'> = type() === 'distance'
      ? { view: view(), type: 'distance', a: a()!, b: b()!, along: along(), offset: Number.isFinite(off) ? off : 10 }
      : { view: view(), type: type(), near: a()!, offset: Number.isFinite(off) ? off : 10 };
    if (label().trim()) dim.text = label().trim();
    if (await addDimension(dim)) setDrawingForm(null);
  };
  return (
    <DialogFrame
      label="Dimension"
      testid="dimension-form"
      icon="dimension"
      title="Dimension"
      actions={
        <>
          <button class="dialog-action ok" disabled={!ready()} aria-label="Add dimension" data-tip="Add dimension" data-keys="Enter" data-testid="dimension-ok" onClick={() => void add()}><Icon name="check" /></button>
          <button class="dialog-action" aria-label="Cancel" data-tip="Cancel" data-keys="Esc" onClick={() => setDrawingForm(null)}><Icon name="close" /></button>
        </>
      }
    >
      <div class="segment" role="radiogroup" aria-label="Dimension type">
        <For each={['distance', 'diameter', 'radius'] as const}>{(t) => <button classList={{ on: type() === t }} role="radio" aria-checked={type() === t} data-dimension-type={t} onClick={() => setType(t)}>{t[0].toUpperCase() + t.slice(1)}</button>}</For>
      </div>
      <label class="field">
        <span class="field-label">View</span>
        <select class="select" data-testid="dimension-view" onChange={(e) => setView(Number(e.currentTarget.value))}>
          <For each={views()}>{(v) => <option value={v.id} selected={v.id === view()}>{viewLabel(v)}</option>}</For>
        </select>
      </label>
      <Show when={type() === 'distance'} fallback={<SpotField label="Circle near" value={a()} set={setA} testid="dimension-near" />}>
        <SpotField label="From" value={a()} set={setA} testid="dimension-a" />
        <SpotField label="To" value={b()} set={setB} testid="dimension-b" />
        <div class="field">
          <span class="field-label">Measured</span>
          <div class="segment" role="radiogroup" aria-label="Measured">
            <For each={['horizontal', 'vertical', 'aligned'] as const}>{(t) => <button classList={{ on: along() === t }} role="radio" aria-checked={along() === t} data-along={t} onClick={() => setAlong(t)}>{t[0].toUpperCase() + t.slice(1)}</button>}</For>
          </div>
        </div>
      </Show>
      <label class="field">
        <span class="field-label">Offset</span>
        <span class="field-input"><input data-testid="dimension-offset" value={offset()} onInput={(e) => setOffset(e.currentTarget.value)} onKeyDown={keep} /><span class="unit">mm</span></span>
      </label>
      <label class="field">
        <span class="field-label">Text</span>
        <span class="field-input"><input data-testid="dimension-text" placeholder="The value" value={label()} onInput={(e) => setLabel(e.currentTarget.value)} onKeyDown={(e) => { keep(e); if (e.key === 'Enter') void add(); }} /></span>
      </label>
      <p class="field-hint">{type() === 'distance' ? 'Sketch points follow the model as it changes.' : 'The circle seen face on in that view nearest the point, such as a hole\'s sketch point.'} In the text, &lt;&gt; stands for the value.</p>
    </DialogFrame>
  );
}
