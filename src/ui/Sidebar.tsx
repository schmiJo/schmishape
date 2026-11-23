import { createMemo, createSignal, For, Show } from 'solid-js';
import { partLabel } from '../features/words';
import { activeDef, cancelDialog, editFeature, featurePickable, featurePicks, pickFeature, pickKind, pickLimit, pickRef, pickTakesPlanes, pickWholeSketch, quadPickable, refPicked, regionPicksShown, startFeature, takesRegions } from '../features/dialog';
import { DEFAULT_PLANES, FEATURE_QUAD, hiddenPlanes, isPlaneFeature, planeFrame, setPlanesHidden } from '../store/planes';
import { editSketch, finishSketch, hiddenSketchIds, normalTo, session, setSketchShown, sketchShown, startSketch } from '../sketch/controller';
import { PLANES } from '../sketch/geometry';
import { activeConfiguration, applyConfiguration, configurations, deleteConfiguration, saveConfiguration, commit, deleteFeature, doc, isHidden, holes, isSketchFeature, mesh, moveFeature, numberOr, partLooks, setPartLook, setRollback, setSuppressed, type ToolError } from '../store/doc';
import { setHoveredFeature, setHiddenParts, renamingPart, setAppearanceFor, setRenamingPart, clearSelection, geometryHidden, hiddenParts, mode, selectedFeature, selectedGeometry, selectedPart, setHoverPlane, setMode, setSelectedFeature, setSelectedGeometry, setSelectedPart, setSelection, toast, toggleGeometry, togglePart } from '../store/ui';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { setFlatBody, setFlatOpen, sheetParts } from '../store/sheetmetal';
import { exportFlatDxf } from '../files';
import { Icon, iconForFeature } from './icons';

const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * What a feature row says on hover: why it failed, or what a drawing would say of each hole it made (alike ones once,
 * counted) and anything the kernel noted, such as a blind hole that went right through.
 */
function rowTip(id: number, step: { state: string; error?: string; notes?: string[] } | undefined): string | undefined {
  if (step?.state === 'failed') return step.error;
  const lines: string[] = [];
  const counts = new Map<string, number>();
  for (const h of holes().get(id) ?? []) counts.set(h.callout, (counts.get(h.callout) ?? 0) + 1);
  for (const [callout, n] of counts) lines.push(n > 1 ? `${n} × ${callout}` : callout);
  for (const n of step?.notes ?? []) lines.push(sentence(n));
  return lines.length ? lines.join('\n') : undefined;
}

const fail = (e: unknown) => toast((e as ToolError).message, 'error');

/** Opening a feature rolls the model back to it, so whatever's open closes first: a sketch is kept and a dialog cancelled, as Esc does. */
async function open(f: any) {
  if (session()) {
    await finishSketch();
    if (session()) return;
  }
  if (isSketchFeature(f)) {
    await cancelDialog();
    editSketch(f.id);
  } else editFeature(f.id);
}

type Menu = { x: number; y: number; items: (MenuItem | null)[] };

/** With `quiet`, a hidden state that's only the default, which shows only on hover, as a used sketch's does. */
function Eye(props: { hidden: boolean; name: string; toggle: () => void; quiet?: boolean }) {
  return (
    <button
      class="row-eye"
      classList={{ off: props.hidden && !props.quiet }}
      aria-label={`${props.hidden ? 'Show' : 'Hide'} ${props.name}`}
      aria-pressed={props.hidden}
      data-tip={props.hidden ? 'Show' : 'Hide'}
      onClick={(e) => {
        e.stopPropagation();
        props.toggle();
      }}
    >
      <Icon name={props.hidden ? 'eye-off' : 'eye'} />
    </button>
  );
}

function DefaultGeometry(props: { openMenu: (m: Menu) => void }) {
  const [expanded, setExpanded] = createSignal(true);
  const planeMenu = (p: (typeof PLANES)[number], e: MouseEvent) => {
    e.preventDefault();
    setSelectedGeometry(p.id);
    props.openMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'New sketch', keys: 'Shift S', command: 'menu.sketch', run: () => startSketch(p.plane) },
        { label: 'Normal to plane', keys: 'N', run: () => normalTo(p.plane) },
        null,
        { label: geometryHidden().has(p.id) ? 'Show plane' : 'Hide plane', run: () => toggleGeometry(p.id) },
      ],
    });
  };
  return (
    <>
      <button class="group-row" aria-expanded={expanded()} onClick={() => setExpanded(!expanded())}>
        <span class="group-caret" classList={{ closed: !expanded() }}><Icon name="caret" size={13} /></span>
        Default geometry
      </button>
      <Show when={expanded()}>
        <div
          class="geo-row"
          classList={{ selected: selectedGeometry() === 'origin', off: geometryHidden().has('origin') }}
          data-geometry="origin"
          tabIndex={0}
          onClick={() => { clearSelection(); setSelectedGeometry('origin'); }}
          onContextMenu={(e) => {
            e.preventDefault();
            props.openMenu({ x: e.clientX, y: e.clientY, items: [{ label: geometryHidden().has('origin') ? 'Show origin' : 'Hide origin', run: () => toggleGeometry('origin') }] });
          }}
        >
          <Icon name="origin" />
          <span class="feature-name">Origin</span>
          <Eye hidden={geometryHidden().has('origin')} name="origin" toggle={() => toggleGeometry('origin')} />
        </div>
        <For each={PLANES}>
          {(p) => (
            <div
              class="geo-row"
              classList={{ selected: pickTakesPlanes() ? refPicked(DEFAULT_PLANES[p.id - 1]) : selectedGeometry() === p.id, off: geometryHidden().has(p.id) }}
              data-plane={p.id}
              tabIndex={0}
              onPointerEnter={() => setHoverPlane(p.id)}
              onPointerLeave={() => setHoverPlane(null)}
              onClick={() => {
                // Waiting for a plane is the one time a click on it starts a sketch.
                if (mode() === 'pick-plane') {
                  setMode('part');
                  setHoverPlane(null);
                  startSketch(p.plane);
                  return;
                }
                // A box in a dialog waiting for a plane takes it from the list too, as in Onshape.
                if (pickTakesPlanes()) return void pickRef(DEFAULT_PLANES[p.id - 1]);
                clearSelection();
                setSelectedGeometry(p.id);
              }}
              onContextMenu={(e) => planeMenu(p, e)}
            >
              <Icon name="plane" />
              <span class="feature-name">{p.name}</span>
              <Eye hidden={geometryHidden().has(p.id)} name={`${p.name} plane`} toggle={() => toggleGeometry(p.id)} />
            </div>
          )}
        </For>
      </Show>
    </>
  );
}

export function Features() {
  const [menu, setMenu] = createSignal<Menu | null>(null);
  const [renaming, setRenaming] = createSignal<number | null>(null);
  const [filter, setFilter] = createSignal('');
  let list!: HTMLDivElement;

  /**
   * Dragging a feature up or down the list moves it in the history, as in Onshape: a line shows the gap it will go in,
   * and the kernel refuses a move that would put something before what it uses.
   */
  const [drag, setDrag] = createSignal<{ id: number; from: number; to: number } | null>(null);
  let justDragged = false;
  const startDrag = (e: PointerEvent, f: any, index: number) => {
    if (e.button !== 0 || activeDef() || session() || renaming() !== null || filter().trim() || mode() !== 'part') return;
    const row = e.currentTarget as HTMLElement;
    const y0 = e.clientY;
    let on = false;
    const move = (ev: PointerEvent) => {
      if (!on && Math.abs(ev.clientY - y0) < 5) return;
      if (!on) {
        on = true;
        row.setPointerCapture(ev.pointerId);
        document.body.classList.add('dragging-feature');
      }
      const rows = [...list.querySelectorAll<HTMLElement>('.feature-row[data-index]')];
      // The gap above the first row whose middle is below the pointer, or else the one after the last.
      let to = Number(rows[rows.length - 1]?.dataset.index ?? index) + 1;
      for (const r of rows) {
        const b = r.getBoundingClientRect();
        if (ev.clientY < b.top + b.height / 2) { to = Number(r.dataset.index); break; }
      }
      setDrag({ id: f.id, from: index, to });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('dragging-feature');
      const d = drag();
      setDrag(null);
      if (!on || !d) return;
      justDragged = true;
      setTimeout(() => { justDragged = false; }, 0);
      // Taken out from above the gap, everything below it moves up one.
      const position = d.to > d.from ? d.to - 1 : d.to;
      if (position !== d.from) moveFeature(d.id, position).catch(fail);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  /** Where the line goes: above the row at the gap, or below the last row. */
  const dropAbove = (index: number) => { const d = drag(); return !!d && d.to === index && d.to !== d.from && d.to !== d.from + 1; };
  const dropBelow = (index: number) => {
    const d = drag();
    const rows = shown();
    return !!d && index === rows[rows.length - 1]?.index && d.to === index + 1 && d.to !== d.from + 1;
  };
  const visible = createMemo(() => doc.features.map((f, index) => ({ f, index })).filter(({ f }) => !isHidden(f)));
  const shown = createMemo(() => {
    const q = filter().trim().toLowerCase();
    return q ? visible().filter(({ f }) => `${f.name} ${f.type} ${f.shape ?? ''}`.toLowerCase().includes(q)) : visible();
  });
  const stepOf = (id: number) => doc.steps.find((s) => s.id === id);
  const rolledBack = (i: number) => doc.rollback !== null && i > doc.rollback;

  /** The bar is drawn after a different row each time it moves, so it has to take the keyboard's focus back. */
  const focusBar = () => list.querySelector<HTMLElement>('.rollback')?.focus();

  /** Moves the bar one step you can see, passing over the hidden sketches between features. */
  const stepBar = async (by: 1 | -1) => {
    const rows = visible().map((v) => v.index);
    const here = doc.rollback ?? rows[rows.length - 1];
    const next = rows[rows.filter((i) => i <= here).length - 1 + by];
    if (next === undefined) return;
    await setRollback(next === rows[rows.length - 1] ? null : next);
    focusBar();
  };

  const dragBar = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const bar = e.currentTarget as HTMLElement;
    bar.focus();
    bar.setPointerCapture(e.pointerId);
    let last: number | null | undefined;
    const move = (ev: PointerEvent) => {
      const rows = [...list.querySelectorAll<HTMLElement>('[data-index]')];
      let target: number | null = null;
      for (const r of rows) {
        const b = r.getBoundingClientRect();
        if (ev.clientY > b.top + b.height / 2) target = Number(r.dataset.index);
      }
      const end = rows.length && target === Number(rows[rows.length - 1].dataset.index);
      const value = end || target === null ? (target === null ? 0 : null) : target;
      if (value !== last) {
        last = value;
        void setRollback(value);
      }
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      focusBar();
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  };

  const showBarAfter = (i: number) => !filter().trim() && (doc.rollback === null ? !doc.features.slice(i + 1).some((f) => !isHidden(f)) : doc.rollback === i);

  const featureMenu = (f: any, index: number, x: number, y: number) => {
    setSelectedFeature(f.id);
    const frame = isPlaneFeature(f) ? planeFrame(f.id) : null;
    const planeItems: (MenuItem | null)[] = isPlaneFeature(f)
      ? [
        { label: 'New sketch', keys: 'Shift S', disabled: !frame, run: () => startSketch(frame!, { on_plane: f.id }) },
        { label: 'Normal to plane', keys: 'N', disabled: !frame, run: () => normalTo(frame!) },
        { label: hiddenPlanes().includes(f.id) ? 'Show plane' : 'Hide plane', run: () => setPlanesHidden([f.id], !hiddenPlanes().includes(f.id)) },
        null,
      ]
      : [];
    setMenu({
      x,
      y,
      items: [
        ...planeItems,
        { label: 'Edit', keys: 'Enter', run: () => open(f) },
        { label: 'Rename', run: () => setRenaming(f.id) },
        { label: f.suppressed ? 'Turn on' : 'Turn off', run: () => setSuppressed(f.id, !f.suppressed) },
        { label: 'Roll to here', run: () => setRollback(index) },
        null,
        { label: 'Delete', keys: 'Delete', danger: true, run: () => deleteFeature(f.id) },
      ],
    });
  };

  return (
    <section class="panel features" aria-label="Features">
      <h2>Features ({visible().length})</h2>
      <div class="filter">
        <input value={filter()} placeholder="Filter by name or type" aria-label="Filter features" spellcheck={false} onInput={(e) => setFilter(e.currentTarget.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { setFilter(''); e.currentTarget.blur(); } }} />
      </div>
      <div class="feature-list" ref={list} data-testid="history">
        <DefaultGeometry openMenu={setMenu} />
        <For each={shown()}>
          {(item) => {
            const step = () => stepOf(item.f.id);
            return (
              <>
                <div
                  class="feature-row"
                  data-index={item.index}
                  data-feature={item.f.id}
                  classList={{ dragging: drag()?.id === item.f.id, 'drop-above': dropAbove(item.index), 'drop-below': dropBelow(item.index), selected: pickKind() === 'features' ? featurePicks().includes(item.f.id) : pickTakesPlanes() && isPlaneFeature(item.f) ? refPicked(item.f.id) : selectedFeature() === item.f.id || (takesRegions() && regionPicksShown().some((r) => r.sketch === item.f.id)), failed: step()?.state === 'failed', off: !!item.f.suppressed || rolledBack(item.index) }}
                  tabIndex={0}
                  data-tip={rowTip(item.f.id, step())}
                  onPointerDown={(e) => startDrag(e, item.f, item.index)}
                  onClick={() => {
                    if (justDragged) return;
                    // With a dialog waiting for regions, a sketch in the list brings all of its regions.
                    if (takesRegions() && isSketchFeature(item.f) && item.index < pickLimit()) return pickWholeSketch(item.f.id);
                    // A mirror or pattern waiting for features takes them from the list, as in Onshape.
                    if (pickKind() === 'features') return pickFeature(item.f.id);
                    // So does a box waiting for a plane, from the planes before the feature.
                    if (pickTakesPlanes() && isPlaneFeature(item.f)) {
                      if (quadPickable(FEATURE_QUAD + item.f.id)) pickRef(item.f.id);
                      return;
                    }
                    // Waiting for a plane to sketch on, a plane feature is one.
                    if (mode() === 'pick-plane' && isPlaneFeature(item.f)) {
                      const frame = planeFrame(item.f.id);
                      if (!frame) return;
                      setMode('part');
                      setHoverPlane(null);
                      startSketch(frame, { on_plane: item.f.id });
                      return;
                    }
                    clearSelection();
                    setSelectedFeature(item.f.id);
                  }}
                  onPointerEnter={() => { setHoveredFeature(item.f.id); if (isPlaneFeature(item.f)) setHoverPlane(FEATURE_QUAD + item.f.id); }}
                  onPointerLeave={() => { setHoveredFeature(null); if (isPlaneFeature(item.f)) setHoverPlane(null); }}
                  onDblClick={() => {
                    // The two clicks of this have already chosen the sketch for the waiting dialog.
                    if (pickKind() === 'features' && featurePickable(item.f.id)) return;
                    if (pickTakesPlanes() && isPlaneFeature(item.f)) return;
                    if (!(takesRegions() && isSketchFeature(item.f) && item.index < pickLimit())) void open(item.f);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.stopPropagation(); void open(item.f); }
                    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
                      e.preventDefault();
                      const b = e.currentTarget.getBoundingClientRect();
                      featureMenu(item.f, item.index, b.left + 24, b.bottom);
                    }
                  }}
                  onContextMenu={(e) => { e.preventDefault(); featureMenu(item.f, item.index, e.clientX, e.clientY); }}
                >
                  <Icon name={iconForFeature(item.f)} />
                  <Show when={renaming() === item.f.id} fallback={<span class="feature-name">{item.f.name}</span>}>
                    <input
                      class="feature-rename"
                      value={item.f.name}
                      aria-label="Feature name"
                      spellcheck={false}
                      ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                      onClick={(e) => e.stopPropagation()}
                      onDblClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const name = e.currentTarget.value.trim();
                        setRenaming(null);
                        if (name && name !== item.f.name) commit('feature_rename', { id: item.f.id, name }).catch(fail);
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') e.currentTarget.blur();
                        if (e.key === 'Escape') { e.currentTarget.value = item.f.name; e.currentTarget.blur(); }
                      }}
                    />
                  </Show>
                  <Show when={step()?.state === 'failed'}><span class="feature-warn" aria-label="Failed"><Icon name="warn" size={14} /></span></Show>
                  <Show when={step()?.state !== 'failed' && step()?.notes?.length}><span class="feature-note" aria-label="Has notes" data-testid="feature-note"><Icon name="note" size={14} /></span></Show>
                  <Show when={isPlaneFeature(item.f)}><Eye hidden={hiddenPlanes().includes(item.f.id)} name={item.f.name} toggle={() => void setPlanesHidden([item.f.id], !hiddenPlanes().includes(item.f.id)).catch(fail)} /></Show>
                  <Show when={isSketchFeature(item.f) && !item.f.suppressed}><Eye hidden={!sketchShown(item.f.id)} quiet={!hiddenSketchIds().includes(item.f.id)} name={item.f.name} toggle={() => void setSketchShown(item.f.id, !sketchShown(item.f.id)).catch(fail)} /></Show>
                </div>
                <Show when={showBarAfter(item.index)}>
                  <div class="rollback" role="slider" aria-label="Rollback position" aria-valuenow={item.index} aria-valuemin={0} aria-valuemax={doc.features.length - 1} tabIndex={0} data-tip="Drag to see the part at an earlier step. New features go in here." data-keys="↑ ↓" onPointerDown={dragBar} onKeyDown={(e) => {
                    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                    e.preventDefault();
                    e.stopPropagation();
                    void stepBar(e.key === 'ArrowUp' ? -1 : 1);
                  }} onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, items: [{ label: 'Roll to end', disabled: doc.rollback === null, run: () => setRollback(null) }] });
                  }} />
                </Show>
              </>
            );
          }}
        </For>
      </div>
      <Show when={menu()}>{(m) => <ContextMenu {...m()} close={() => setMenu(null)} />}</Show>
    </section>
  );
}

export { AssemblyPanels } from '../assembly/ui';

export function Parts() {
  const [menu, setMenu] = createSignal<Menu | null>(null);
  const parts = () => mesh()?.parts ?? [];
  const selectPart = (i: number) => {
    clearSelection();
    setSelectedPart(i);
    setSelection({ faces: [...parts()[i].faces], edges: [] });
  };
  /** Solids, then surfaces, as Onshape lists them, each with its place in the kernel's list for selecting and hiding. */
  const group = (sheet: boolean) => parts().map((p, i) => ({ p, i })).filter((x) => x.p.sheet === sheet);
  const row = (item: { p: { name: string; sheet: boolean }; i: number }) => {
    const name = () => partLabel(parts(), item.p.name, partLooks());
    const hidden = () => hiddenParts().has(item.i);
    const color = () => partLooks()[item.p.name]?.color;
    const busy = () => !!activeDef() || !!session();
    const sheetMetal = () => sheetParts().some((x) => x.body === item.p.name);
    const rename = (text: string) => {
      setRenamingPart(null);
      const next = text.trim();
      // Clearing the name, or giving it the default one, goes back to the default.
      const plain = partLabel(parts(), item.p.name);
      if (next === name()) return;
      setPartLook(item.p.name, { name: next === plain ? '' : next }).catch(fail);
    };
    return (
      <div
        class="geo-row"
        classList={{ selected: selectedPart() === item.i, off: hidden() }}
        data-part={item.i}
        data-body={item.p.name}
        tabIndex={0}
        onClick={() => selectPart(item.i)}
        onDblClick={() => { if (!busy()) setRenamingPart(item.p.name); }}
        onContextMenu={(e) => {
          e.preventDefault();
          selectPart(item.i);
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              { label: 'Rename', disabled: busy(), run: () => setRenamingPart(item.p.name) },
              {
                label: 'Edit appearance…',
                disabled: busy(),
                // Selected, its faces would be tinted orange, and the color being tried wouldn't show as it is.
                run: () => { clearSelection(); setSelectedPart(null); setAppearanceFor(item.p.name); },
              },
              null,
              ...(sheetMetal() ? [
                { label: 'Show flat pattern', run: () => { setFlatBody(item.p.name); setFlatOpen(true); } },
                { label: 'Export flat pattern as DXF', run: () => { setFlatBody(item.p.name); void exportFlatDxf(); } },
                null,
              ] : []),
              { label: hidden() ? 'Show part' : 'Hide part', run: () => togglePart(item.i) },
              { label: 'Hide other parts', disabled: parts().length < 2, run: () => setHiddenParts(new Set(parts().map((_, i) => i).filter((i) => i !== item.i))) },
              { label: 'Show all parts', disabled: hiddenParts().size === 0, run: () => setHiddenParts(new Set()) },
              { label: 'Delete part', disabled: busy(), run: () => void startFeature('delete-bodies') },
            ],
          });
        }}
      >
        <span class="part-icon" style={color() ? { '--part-color': color() } : undefined} classList={{ tinted: !!color() }}>
          <Icon name={item.p.sheet ? 'fill' : sheetMetal() ? 'sheet-metal' : 'part'} />
        </span>
        <Show when={renamingPart() === item.p.name} fallback={<span class="feature-name">{name()}</span>}>
          <input
            class="feature-rename"
            value={name()}
            aria-label="Part name"
            spellcheck={false}
            ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
            onClick={(e) => e.stopPropagation()}
            onDblClick={(e) => e.stopPropagation()}
            onBlur={(e) => rename(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') { e.currentTarget.value = name(); e.currentTarget.blur(); }
            }}
          />
        </Show>
        <Eye hidden={hidden()} name={name()} toggle={() => togglePart(item.i)} />
      </div>
    );
  };
  return (
    <section class="panel parts" aria-label="Parts">
      <h2>Parts ({group(false).length})</h2>
      <div class="parts-list">
        <For each={group(false)}>{row}</For>
      </div>
      <Show when={group(true).length > 0}>
        <h2 class="subhead">Surfaces ({group(true).length})</h2>
        <div class="parts-list">
          <For each={group(true)}>{row}</For>
        </div>
      </Show>
      <Show when={menu()}>{(m) => <ContextMenu {...m()} close={() => setMenu(null)} />}</Show>
    </section>
  );
}

function VariableRow(props: { name: string; value: number | string }) {
  const computed = () => doc.env[props.name];
  const set = (text: string) => {
    const value = numberOr(text);
    if (value === '' || value === props.value) return;
    commit('parameter_set', { name: props.name, value }).catch(fail);
  };
  return (
    <div class="variable-row">
      <span class="variable-name">{props.name}</span>
      <input class="variable-value" value={String(props.value)} aria-label={`Value of ${props.name}`} onChange={(e) => set(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation(); }} />
      <Show when={typeof props.value === 'string' && computed() !== undefined}><span class="variable-computed">{Number(computed().toFixed(3))}</span></Show>
      <button class="row-more" aria-label={`Remove ${props.name}`} data-tip="Remove" onClick={() => commit('parameter_remove', { name: props.name }).catch(fail)}><Icon name="minus" size={13} /></button>
    </div>
  );
}

export function Variables() {
  const [adding, setAdding] = createSignal(false);
  const [naming, setNaming] = createSignal(false);
  const [menu, setMenu] = createSignal<Menu | null>(null);
  let nameEl!: HTMLInputElement;
  let valueEl!: HTMLInputElement;
  const add = () => {
    const name = nameEl.value.trim();
    const value = numberOr(valueEl.value);
    if (!name || value === '') return;
    commit('parameter_set', { name, value }).then(() => setAdding(false)).catch(fail);
  };
  const active = () => activeConfiguration();
  /** Whether the variables still have the values of the configuration chosen. */
  const changed = () => {
    const c = configurations().find((x) => x.name === active());
    return !!c && Object.entries(c.values).some(([k, v]) => String(doc.parameters.find((p) => p.name === k)?.value) !== String(v));
  };
  const more = (e: MouseEvent) => {
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: b.left,
      y: b.bottom + 2,
      items: [
        { label: 'Save values as a configuration…', disabled: !doc.parameters.length, run: () => setNaming(true) },
        { label: active() ? `Update ${active()} with these values` : 'Update configuration', disabled: !active() || !changed(), run: () => void saveConfiguration(active()!).catch(fail) },
        null,
        { label: active() ? `Delete ${active()}` : 'Delete configuration', danger: true, disabled: !active(), run: () => void deleteConfiguration(active()!).catch(fail) },
      ],
    });
  };
  return (
    <section class="panel variables" aria-label="Variables">
      <h2>
        Variables ({doc.parameters.length})
        <span class="panel-tools">
          <button class="mini" aria-label="Configurations" data-tip="Configurations" onClick={more} data-testid="configurations"><Icon name="caret" size={13} /></button>
          <button class="mini" aria-label="Add a variable" data-tip="Add a variable" onClick={() => { setAdding(true); nameEl?.focus(); }}><Icon name="plus" size={13} /></button>
        </span>
      </h2>
      <Show when={configurations().length}>
        <label class="config-row">
          <span>Configuration</span>
          <select class="select" data-testid="configuration" value={active() ?? ''} onChange={(e) => void applyConfiguration(e.currentTarget.value).catch(fail)}>
            <Show when={!active()}><option value="" selected>Choose one</option></Show>
            <For each={configurations()}>{(c) => <option value={c.name} selected={c.name === active()}>{c.name}{c.name === active() && changed() ? ' (changed)' : ''}</option>}</For>
          </select>
        </label>
      </Show>
      <Show when={naming()}>
        <div class="variable-row adding">
          <input
            placeholder="Configuration name"
            aria-label="Configuration name"
            ref={(el) => queueMicrotask(() => el.focus())}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') setNaming(false);
              if (e.key === 'Enter') {
                const name = e.currentTarget.value.trim();
                if (name) saveConfiguration(name).then(() => setNaming(false)).catch(fail);
              }
            }}
            onBlur={() => setNaming(false)}
          />
        </div>
      </Show>
      <For each={doc.parameters}>{(p) => <VariableRow name={p.name} value={p.value} />}</For>
      <Show when={adding()}>
        <div class="variable-row adding">
          <input ref={(el) => { nameEl = el; queueMicrotask(() => el.focus()); }} placeholder="width" aria-label="New variable name" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setAdding(false); if (e.key === 'Enter') valueEl.focus(); }} />
          <input ref={valueEl} placeholder="40" aria-label="New variable value" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setAdding(false); if (e.key === 'Enter') add(); }} />
        </div>
      </Show>
      <Show when={menu()}>{(m) => <ContextMenu {...m()} close={() => setMenu(null)} />}</Show>
    </section>
  );
}
