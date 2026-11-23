import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { command } from '../commands';
import { activeDef } from '../features/dialog';
import { cancelSketch, finishSketch, session } from '../sketch/controller';
import type { SketchSession, Tool } from '../sketch/session';
import { MATE_TYPES } from '../assembly/model';
import { AssemblyStatus } from '../assembly/ui';
import { doc, setTitle, UNTITLED } from '../store/doc';
import { inAssembly, inDrawing } from '../store/tabs';
import { DrawingTools } from '../drawing/ui';
import { flatOpen } from '../store/sheetmetal';
import { section } from '../store/section';
import { massOpen } from './MassPanel';
import { mode, setPaletteOpen, snapsOn, toggleSnaps } from '../store/ui';
import { closeOnEscape } from './ContextMenu';
import { versionsOpen } from '../store/versions';
import { Icon } from './icons';

/** A finished sketch nothing has used yet: the obvious next step is to extrude it. */
function sketchWaiting() {
  const last = doc.features[doc.features.length - 1];
  return !!last && last.type === 'constrained_sketch' && !activeDef();
}

/** With `held`, a button that shows something stays pressed in while it's on show. */
function ToolButton(props: { id: string; held?: () => boolean }) {
  const c = command(props.id);
  return (
    <button class="tool" classList={{ suggested: props.id === 'extrude' && sketchWaiting(), held: !!props.held?.() }} aria-pressed={props.held ? props.held() : undefined} aria-label={c.title} data-tip={c.title} data-keys={c.keys} disabled={c.enabled ? !c.enabled() : false} onClick={() => void c.run()} data-command={c.id}>
      <Icon name={c.icon} />
    </button>
  );
}

type MenuEntry = string | { heading: string } | null;
const APP_MENU: MenuEntry[] = [
  { heading: 'File' },
  'new', 'tab.assembly', 'tab.drawing', 'tab.folder', null, 'open', 'save', null, 'versions', 'save.document', 'open.document', null, 'import', 'export.step', 'export.stl', 'export.dxf', null, 'example',
  { heading: 'Edit' },
  'undo', 'redo', 'palette',
  { heading: 'View' },
  'fit', 'view.normal', 'view.planes', 'view.sketches', 'view.section', 'mass', 'tab.manager',
  { heading: 'Help' },
  'shortcuts',
];

/** The mark: an S traced along the edges of a cube, ending in a sketch handle. Drawn in a line, it becomes a shape. */
function LogoMark() {
  return (
    <svg class="logo-mark" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.66 7L12 2L3.34 7L20.66 17L12 22L3.34 17" fill="none" stroke="#23272B" stroke-width="3" stroke-linejoin="miter" />
      <rect x="1.2" y="14.7" width="4.4" height="4.4" fill="#FFB61E" />
    </svg>
  );
}

function LogoMenu() {
  const [open, setOpen] = createSignal<{ x: number; y: number } | null>(null);
  closeOnEscape(() => !!open(), () => setOpen(null));
  return (
    <>
      <button
        class="logo"
        classList={{ on: !!open() }}
        aria-label="schmishape menu"
        aria-haspopup="menu"
        aria-expanded={!!open()}
        data-testid="file-menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(open() ? null : { x: r.left, y: r.bottom + 1 });
        }}
      >
        <LogoMark />
        <span class="wordmark">schmi<b>shape</b></span>
        <Icon name="caret" size={10} />
      </button>
      <Show when={open()}>
        {(o) => (
          <>
            <div class="menu-scrim" onPointerDown={() => setOpen(null)} />
            <div class="menu app-menu" role="menu" style={{ left: `${o().x}px`, top: `${o().y}px` }}>
              <For each={APP_MENU}>
                {(entry) => {
                  if (entry === null) return <div class="menu-rule" />;
                  if (typeof entry !== 'string') return <div class="menu-heading">{entry.heading}</div>;
                  const c = command(entry);
                  return (
                    <button role="menuitem" disabled={c.enabled ? !c.enabled() : false} onClick={() => { setOpen(null); void c.run(); }} data-command={c.id}>
                      {c.title}
                      <Show when={c.keys}><kbd>{c.keys}</kbd></Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </>
        )}
      </Show>
    </>
  );
}

type SketchTool = { tool: Tool; icon: string; label: string; key: string };
const DRAW_TOOLS: SketchTool[] = [
  { tool: 'line', icon: 'line', label: 'Line', key: 'L' },
  { tool: 'rect', icon: 'rect', label: 'Corner rectangle', key: 'R' },
  { tool: 'rect-center', icon: 'rect-center', label: 'Center rectangle', key: 'Shift R' },
  { tool: 'circle', icon: 'circle', label: 'Center circle', key: 'C' },
  { tool: 'circle-3pt', icon: 'circle-3pt', label: '3-point circle', key: 'Shift C' },
  { tool: 'arc', icon: 'arc', label: '3-point arc', key: 'A' },
  { tool: 'arc-center', icon: 'arc-center', label: 'Center arc', key: 'Shift A' },
  { tool: 'arc-tangent', icon: 'arc-tangent', label: 'Tangent arc', key: 'Shift T' },
  { tool: 'slot', icon: 'slot', label: 'Straight slot', key: 'O' },
  { tool: 'polygon', icon: 'polygon', label: 'Inscribed polygon', key: 'Shift P' },
  { tool: 'spline', icon: 'spline', label: 'Spline', key: 'S' },
  { tool: 'point', icon: 'point', label: 'Point', key: 'P' },
  { tool: 'text', icon: 'text', label: 'Text', key: 'Shift W' },
];
const EDIT_TOOLS: SketchTool[] = [
  { tool: 'trim', icon: 'trim', label: 'Trim', key: 'T' },
  { tool: 'extend', icon: 'extend', label: 'Extend', key: 'Shift X' },
  { tool: 'sketch-fillet', icon: 'sketch-fillet', label: 'Round a corner', key: 'Shift F' },
  { tool: 'offset', icon: 'sketch-offset', label: 'Offset', key: 'Shift O' },
  { tool: 'mirror', icon: 'mirror', label: 'Mirror', key: 'Shift M' },
  { tool: 'sketch-linear', icon: 'sketch-linear', label: 'Linear pattern', key: '' },
  { tool: 'sketch-circular', icon: 'sketch-circular', label: 'Circular pattern', key: '' },
];

const CONSTRAINTS: { type: string; icon: string; label: string; key?: string }[] = [
  { type: 'coincident', icon: 'coincident', label: 'Coincident' },
  { type: 'horizontal', icon: 'horizontal', label: 'Horizontal', key: 'H' },
  { type: 'vertical', icon: 'vertical', label: 'Vertical', key: 'I' },
  { type: 'parallel', icon: 'parallel', label: 'Parallel' },
  { type: 'perpendicular', icon: 'perpendicular', label: 'Perpendicular' },
  { type: 'equal', icon: 'equal', label: 'Equal' },
  { type: 'tangent', icon: 'tangent', label: 'Tangent' },
  { type: 'concentric', icon: 'concentric', label: 'Concentric' },
  { type: 'midpoint', icon: 'midpoint', label: 'Midpoint' },
  { type: 'symmetric', icon: 'symmetric', label: 'Symmetric' },
  { type: 'fix', icon: 'fix', label: 'Fix in place' },
];

function SketchStatus(props: { session: SketchSession }) {
  const status = () => {
    const a = props.session.analysis[0]();
    if (a.redundant.length) return { text: 'More constraints than it needs', tone: 'warn' };
    if (!props.session.data.entities.length) return { text: 'Start drawing', tone: '' };
    if (a.dof === 0) return { text: 'Fully defined', tone: 'done' };
    return { text: `${a.dof} ${a.dof === 1 ? 'freedom' : 'freedoms'} left`, tone: '' };
  };
  return <div class="sketch-status" classList={{ done: status().tone === 'done', warn: status().tone === 'warn' }} data-testid="sketch-status">{status().text}</div>;
}

function SketchTools(props: { session: SketchSession }) {
  const s = () => props.session;
  const toolButton = (t: SketchTool) => (
    <button class="tool" classList={{ on: s().tool[0]() === t.tool && !s().constraintTool[0]() }} aria-label={t.label} data-tip={t.label} data-keys={t.key} aria-pressed={s().tool[0]() === t.tool && !s().constraintTool[0]()} onClick={() => s().setTool(t.tool)} data-tool={t.tool}>
      <Icon name={t.icon} />
    </button>
  );
  return (
    <>
      <div class="tool-group" role="toolbar" aria-label="Select">{toolButton({ tool: 'select', icon: 'select', label: 'Select', key: 'V' })}</div>
      <div class="tool-group" role="toolbar" aria-label="Drawing tools"><For each={DRAW_TOOLS}>{toolButton}</For></div>
      <div class="tool-group" role="toolbar" aria-label="Editing tools">
        <For each={EDIT_TOOLS}>{toolButton}</For>
        <button class="tool" classList={{ held: s().constructing[0]() }} aria-label="Construction geometry" aria-pressed={s().constructing[0]()} data-tip={s().picks().edges.length ? 'Make the selection construction geometry' : 'Draw construction geometry'} data-keys="Q" onClick={() => s().toggleConstruction()} data-tool="construction">
          <Icon name="construction" />
        </button>
        <button class="tool" aria-label="Use" data-tip="Use: bring the selected part edges into the sketch, still following the part" data-keys="U" disabled={!s().canUse()} onClick={() => s().useSelection()} data-tool="use">
          <Icon name="use" />
        </button>
        {toolButton({ tool: 'dimension', icon: 'dimension', label: 'Dimension', key: 'D' })}
      </div>
      <div class="tool-group" role="toolbar" aria-label="Constraints">
        <For each={CONSTRAINTS}>
          {(c) => (
            <button class="tool" classList={{ on: s().constraintTool[0]() === c.type }} aria-label={c.label} aria-pressed={s().constraintTool[0]() === c.type} data-tip={c.label} data-keys={c.key} onClick={() => s().useConstraint(c.type)} data-constraint={c.type}>
              <Icon name={c.icon} />
            </button>
          )}
        </For>
      </div>
      <div class="tool-group" role="toolbar" aria-label="Snapping">
        <button class="tool" classList={{ held: snapsOn() }} aria-label="Snapping" aria-pressed={snapsOn()} data-tip={snapsOn() ? 'Snapping is on. Click to draw freely, or hold Shift for a moment' : 'Snapping is off. Click to turn it on'} data-keys="M" onClick={toggleSnaps} data-testid="snap-toggle">
          <Icon name="snap" />
        </button>
      </div>
    </>
  );
}

interface ToolGroup { label: string; ids: string[] }
const PART_GROUPS: ToolGroup[] = [
  { label: 'Sketch and planes', ids: ['sketch', 'plane'] },
  { label: 'Make solids', ids: ['extrude', 'revolve', 'sweep', 'loft', 'helix'] },
  { label: 'Edges and faces', ids: ['fillet', 'chamfer', 'draft', 'rib', 'shell', 'hole'] },
  { label: 'Faces', ids: ['offset', 'thicken', 'delete-face', 'copy-faces'] },
  { label: 'Copy and move', ids: ['mirror', 'pattern-linear', 'pattern-circular', 'transform'] },
  { label: 'Parts', ids: ['boolean', 'split', 'delete-bodies'] },
  { label: 'Surfaces', ids: ['fill', 'sew', 'trim-surface'] },
  { label: 'Sheet metal', ids: ['sheet-metal', 'flange', 'hem', 'tab', 'bend', 'flat-pattern'] },
  { label: 'Inspect', ids: ['view.section', 'mass'] },
];
/** Tools that show something stay pressed in while it's on show. */
const HELD: Record<string, () => boolean> = { 'flat-pattern': flatOpen, 'view.section': () => !!section(), mass: massOpen };

/**
 * A row of tool groups. Groups that don't fit go, from the end, into a menu at the end of the row, as Onshape's toolbar
 * does, so no tool is ever out of reach.
 */
function ToolRow(props: { label: string; groups: ToolGroup[] }) {
  let row!: HTMLDivElement;
  const [fits, setFits] = createSignal(props.groups.length);
  const [menuAt, setMenuAt] = createSignal<{ x: number; y: number } | null>(null);
  let widths: number[] = [];
  const measure = () => {
    const els = [...row.querySelectorAll<HTMLElement>(':scope > .tool-group')];
    // Widths are taken once, with every group on show, since a hidden one has none.
    if (widths.length !== els.length || widths.some((w) => !w)) widths = els.map((e) => e.offsetWidth);
    const room = row.clientWidth;
    const more = 34;
    let used = 0;
    let n = 0;
    for (const w of widths) {
      const last = n === widths.length - 1;
      if (used + w + (last ? 0 : more) > room) break;
      used += w;
      n++;
    }
    setFits(n);
  };
  onMount(() => {
    const ro = new ResizeObserver(() => measure());
    ro.observe(row);
    onCleanup(() => ro.disconnect());
    requestAnimationFrame(measure);
  });
  const hidden = () => props.groups.slice(fits());
  let moreButton!: HTMLButtonElement;
  closeOnEscape(() => !!menuAt(), () => setMenuAt(null));
  return (
    <div class="tools" role="toolbar" aria-label={props.label} ref={row}>
      <For each={props.groups}>
        {(g, i) => (
          <div class="tool-group" role="group" aria-label={g.label} style={i() >= fits() ? { display: 'none' } : undefined}>
            <For each={g.ids}>{(id) => <ToolButton id={id} held={HELD[id]} />}</For>
          </div>
        )}
      </For>
      <Show when={hidden().length}>
        <div class="tool-group">
          <button
            ref={moreButton}
            class="tool"
            aria-label="More tools"
            data-tip="More tools"
            aria-haspopup="menu"
            aria-expanded={!!menuAt()}
            data-testid="more-tools"
            onClick={() => { const b = moreButton.getBoundingClientRect(); setMenuAt(menuAt() ? null : { x: Math.min(b.left, window.innerWidth - 230), y: b.bottom + 4 }); }}
          >
            <Icon name="caret" />
          </button>
        </div>
      </Show>
      <Show when={menuAt()}>
        {(at) => (
          <>
            <div class="menu-scrim" onPointerDown={() => setMenuAt(null)} />
            <div class="menu" role="menu" style={{ left: `${at().x}px`, top: `${at().y}px` }}>
              <For each={hidden()}>
                {(g, i) => (
                  <>
                    <Show when={i() > 0}><div class="menu-rule" role="separator" /></Show>
                    <div class="menu-heading">{g.label}</div>
                    <For each={g.ids.map(command)}>
                      {(c) => (
                        <button role="menuitem" disabled={c.enabled ? !c.enabled() : false} onClick={() => { setMenuAt(null); void c.run(); }} data-command={c.id}>
                          <span class="menu-label"><Icon name={c.icon} /><span class="menu-tool-name">{c.title}</span></span>
                          <Show when={c.keys}><kbd>{c.keys}</kbd></Show>
                        </button>
                      )}
                    </For>
                  </>
                )}
              </For>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

export function TopBar() {
  const c = (id: string) => command(id);
  return (
    <header class="topbar">
      <div class="brand">
        <LogoMenu />
        <span class="brand-rule" />
        <input class="title" value={doc.title} aria-label="Document name" spellcheck={false} onChange={(e) => setTitle(e.currentTarget.value.trim() || UNTITLED)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }} />
        <button class="tool" aria-label="Undo" data-tip="Undo" data-keys="Ctrl Z" disabled={!c('undo').enabled!()} onClick={() => void c('undo').run()}><Icon name="undo" /></button>
        <button class="tool" aria-label="Redo" data-tip="Redo" data-keys="Ctrl Shift Z" disabled={!c('redo').enabled!()} onClick={() => void c('redo').run()}><Icon name="redo" /></button>
        <button class="tool" classList={{ on: versionsOpen() }} aria-label="Versions" data-tip="Versions" data-testid="versions-button" disabled={!c('versions').enabled!()} onClick={() => void c('versions').run()}><Icon name="versions" /></button>
      </div>
      <Show when={session()} keyed fallback={inDrawing() ? <DrawingTools /> : inAssembly() ? (
        <div class="tools" role="toolbar" aria-label="Assembly tools">
          <div class="tool-group"><ToolButton id="asm.insert" /></div>
          <div class="tool-group"><For each={MATE_TYPES}>{(t) => <ToolButton id={`asm.mate.${t}`} />}</For></div>
          <div class="tool-group"><ToolButton id="asm.pattern.linear" /><ToolButton id="asm.pattern.circular" /><ToolButton id="asm.replicate" /></div>
          <div class="tool-group"><ToolButton id="asm.explode" /><ToolButton id="asm.position" /></div>
        </div>
      ) : (
        <ToolRow label="Modelling tools" groups={PART_GROUPS} />
      )}>
        {(active) => (
          <div class="tools sketch-tools">
            <SketchTools session={active} />
          </div>
        )}
      </Show>
      <div class="end">
        <Show when={inAssembly() && mode() !== 'sketch'}><AssemblyStatus /></Show>
        <Show when={mode() === 'sketch'} fallback={
          <button class="search" onClick={() => setPaletteOpen(true)} aria-label="Search commands" data-testid="search"><Icon name="search" size={14} /><span>Search commands</span><kbd>Ctrl K</kbd></button>
        }>
          <Show when={session()} keyed>{(active) => <SketchStatus session={active} />}</Show>
          <button class="btn" onClick={cancelSketch} data-testid="sketch-cancel">Discard</button>
          <button class="btn primary" onClick={() => void finishSketch()} data-tip="Finish sketch" data-keys="Ctrl Enter" data-testid="sketch-done">Finish sketch</button>
        </Show>
      </div>
    </header>
  );
}
