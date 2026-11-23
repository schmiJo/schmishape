import { createSignal, For, Match, Show, Switch } from 'solid-js';
import { closeOnEscape, ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { DialogFrame } from '../ui/DialogFrame';
import { Icon } from '../ui/icons';
import './assembly.css';
import { MATE_TYPES, type MateData } from './model';
import {
  acceptMate, asm, asmFreedom, cancelMate, deleteInstances, deleteMate, editMate, insertOpen, insertParts, insertRows, instanceById, instanceName, instanceProblem, mateDraft, mateFailures,
  openInsert, renameInstance, renameMate, renamingInstance, renamingMate, selectedInstances, selectedMate, selectInstances, setFixed, setHidden, setInsertOpen, setMateSuppressed, setRenamingInstance,
  setRenamingMate, setSelectedMate, updateDraft, partOf, type PickedConnector,
  acceptExtra, cancelExtra, copies, deleteExtra, editExtra, extraDraft, extraMissing, goToPosition, setExtraSuppressed, showExplode, shownExplode,
  updateExtra, setExtraDraft,
} from './store';
import { replicatePlaces } from './extras';
import type { ConnectorRef } from './model';
import { MATE_DOF, mateTypeName, tangentFreedom, type MateType } from './solver';
import { shapeOf } from './connectors';

type Menu = { x: number; y: number; items: (MenuItem | null)[] };

const WHAT_MOVES: Record<MateType, string> = {
  fastened: 'No movement between them',
  revolute: 'Turns about Z',
  slider: 'Slides along Z',
  planar: 'Slides in X and Y, turns about Z',
  cylindrical: 'Slides along Z and turns about Z',
  'pin-slot': 'Turns about Z and slides along X',
  ball: 'Turns any way about a point',
  parallel: 'Moves anywhere and turns about Z',
  tangent: 'Keeps two faces touching: flat, cylindrical or spherical',
  width: 'Keeps the second connector on the first one’s XY plane: pick two faces each side to centre a tab in a slot',
};

export const mateIcon = (t: MateType) => `mate-${t}`;

function RenameInput(props: { value: string; label: string; commit: (name: string) => void; done: () => void }) {
  return (
    <input
      class="feature-rename"
      value={props.value}
      aria-label={props.label}
      spellcheck={false}
      ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
      onClick={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        const name = e.currentTarget.value.trim();
        props.done();
        if (name && name !== props.value) props.commit(name);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { e.currentTarget.value = props.value; e.currentTarget.blur(); }
      }}
    />
  );
}

function InstanceRow(props: { id: string; openMenu: (m: Menu) => void }) {
  const inst = () => instanceById(props.id);
  const problem = () => { const i = inst(); return i ? instanceProblem(i) : null; };
  const menu = (x: number, y: number) => {
    const i = inst();
    if (!i) return;
    if (!selectedInstances().includes(i.id)) selectInstances([i.id]);
    props.openMenu({
      x,
      y,
      items: [
        { label: i.hidden ? 'Show' : 'Hide', run: () => setHidden(i.id, !i.hidden) },
        { label: i.fixed ? 'Unfix' : 'Fix', run: () => setFixed(i.id, !i.fixed) },
        { label: 'Rename', run: () => setRenamingInstance(i.id) },
        null,
        { label: 'Delete', keys: 'Delete', danger: true, run: () => deleteInstances([i.id]) },
      ],
    });
  };
  return (
    <Show when={inst()}>
      {(i) => (
        <div
          class="asm-row"
          classList={{ selected: selectedInstances().includes(i().id), off: i().hidden, failed: !!problem() }}
          data-instance={i().id}
          tabIndex={0}
          data-tip={problem() ?? undefined}
          onClick={(e) => {
            const cur = selectedInstances();
            selectInstances(e.shiftKey ? (cur.includes(i().id) ? cur.filter((x) => x !== i().id) : [...cur, i().id]) : [i().id]);
          }}
          onContextMenu={(e) => { e.preventDefault(); menu(e.clientX, e.clientY); }}
          onKeyDown={(e) => {
            if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
              e.preventDefault();
              const b = e.currentTarget.getBoundingClientRect();
              menu(b.left + 24, b.bottom);
            }
          }}
        >
          <Icon name="part" />
          <Show
            when={renamingInstance() === i().id}
            fallback={
              <>
                <span class="feature-name" data-tip={instanceName(i())}>{/^(.*) <\d+>$/.exec(instanceName(i()))?.[1] ?? instanceName(i())}</span>
                <Show when={/<\d+>$/.exec(instanceName(i()))}>{(n) => <span class="asm-number">{n()[0]}</span>}</Show>
              </>
            }
          >
            <RenameInput value={instanceName(i())} label="Instance name" commit={(name) => renameInstance(i().id, name)} done={() => setRenamingInstance(null)} />
          </Show>
          <Show when={i().fixed}><span class="asm-fixed" aria-label="Fixed" data-tip="Fixed in place"><Icon name="fix" /></span></Show>
          <Show when={problem()}><span class="feature-warn" aria-label="Failed"><Icon name="warn" size={14} /></span></Show>
          <button
            class="row-eye"
            classList={{ off: i().hidden }}
            aria-label={`${i().hidden ? 'Show' : 'Hide'} ${instanceName(i())}`}
            aria-pressed={i().hidden}
            data-tip={i().hidden ? 'Show' : 'Hide'}
            onClick={(e) => { e.stopPropagation(); setHidden(i().id, !i().hidden); }}
          >
            <Icon name={i().hidden ? 'eye-off' : 'eye'} />
          </button>
        </div>
      )}
    </Show>
  );
}

function MateRow(props: { mate: MateData; openMenu: (m: Menu) => void }) {
  const failure = () => mateFailures().get(props.mate.id);
  const who = () => {
    const a = instanceById(props.mate.a), b = instanceById(props.mate.b);
    return a && b ? `${instanceName(a)} and ${instanceName(b)}` : undefined;
  };
  const menu = (x: number, y: number) => {
    setSelectedMate(props.mate.id);
    props.openMenu({
      x,
      y,
      items: [
        { label: 'Edit', keys: 'Enter', run: () => editMate(props.mate.id) },
        { label: 'Rename', run: () => setRenamingMate(props.mate.id) },
        { label: props.mate.suppressed ? 'Unsuppress' : 'Suppress', run: () => setMateSuppressed(props.mate.id, !props.mate.suppressed) },
        null,
        { label: 'Delete', keys: 'Delete', danger: true, run: () => deleteMate(props.mate.id) },
      ],
    });
  };
  return (
    <div
      class="asm-row"
      classList={{ selected: selectedMate() === props.mate.id, off: props.mate.suppressed, failed: !!failure() }}
      data-mate={props.mate.id}
      tabIndex={0}
      data-tip={failure() ?? who()}
      onClick={() => { selectInstances([]); setSelectedMate(props.mate.id); }}
      onDblClick={() => editMate(props.mate.id)}
      onContextMenu={(e) => { e.preventDefault(); menu(e.clientX, e.clientY); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.stopPropagation(); editMate(props.mate.id); }
        if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
          e.preventDefault();
          const b = e.currentTarget.getBoundingClientRect();
          menu(b.left + 24, b.bottom);
        }
      }}
    >
      <Icon name={mateIcon(props.mate.type)} />
      <Show when={renamingMate() === props.mate.id} fallback={<span class="feature-name">{props.mate.name}</span>}>
        <RenameInput value={props.mate.name} label="Mate name" commit={(name) => renameMate(props.mate.id, name)} done={() => setRenamingMate(null)} />
      </Show>
      <Show when={failure()}><span class="feature-warn" aria-label="Failed"><Icon name="warn" size={14} /></span></Show>
    </div>
  );
}

type ExtraKind = 'pattern' | 'replicate' | 'explode' | 'position';
const EXTRA_WORDS: Record<ExtraKind, string> = { pattern: 'pattern', replicate: 'replicate', explode: 'exploded view', position: 'position' };

/** A pattern, replicate, exploded view or named position in the list. */
function ExtraRow(props: { kind: ExtraKind; id: string; name: string; icon: string; tip: string; suppressed?: boolean; on?: boolean; click?: () => void; openMenu: (m: Menu) => void }) {
  const menu = (x: number, y: number) => {
    const items: (MenuItem | null)[] = [];
    if (props.kind !== 'position') items.push({ label: 'Edit', run: () => editExtra(props.kind as 'pattern', props.id) });
    if (props.kind === 'pattern' || props.kind === 'replicate') items.push({ label: props.suppressed ? 'Unsuppress' : 'Suppress', run: () => setExtraSuppressed(props.kind as 'pattern', props.id, !props.suppressed) });
    items.push(null, { label: 'Delete', danger: true, run: () => deleteExtra(props.kind, props.id) });
    props.openMenu({ x, y, items });
  };
  return (
    <div
      class="asm-row"
      classList={{ off: props.suppressed, selected: props.on }}
      data-extra={props.id}
      data-kind={props.kind}
      tabIndex={0}
      data-tip={props.tip}
      onClick={() => props.click?.()}
      onDblClick={() => { if (props.kind !== 'position') editExtra(props.kind as 'pattern', props.id); }}
      onContextMenu={(e) => { e.preventDefault(); menu(e.clientX, e.clientY); }}
    >
      <Icon name={props.icon} />
      <span class="feature-name">{props.name}</span>
      <button class="row-more" aria-label={`Delete ${EXTRA_WORDS[props.kind]}`} data-tip="Delete" onClick={(e) => { e.stopPropagation(); deleteExtra(props.kind, props.id); }}><Icon name="minus" size={13} /></button>
    </div>
  );
}

/** An assembly's side of the window: its instances, and the mates between them. */
export function AssemblyPanels() {
  const [menu, setMenu] = createSignal<Menu | null>(null);
  return (
    <>
      <section class="panel features" aria-label="Instances">
        <h2>Instances ({asm().instances.length})</h2>
        <div class="asm-list" data-testid="instances">
          <For each={asm().instances}>{(i) => <InstanceRow id={i.id} openMenu={setMenu} />}</For>
        </div>
      </section>
      <section class="panel parts" aria-label="Mates">
        <h2>Mates ({asm().mates.length})</h2>
        <div class="asm-mates" data-testid="mates">
          <For each={asm().mates}>{(m) => <MateRow mate={m} openMenu={setMenu} />}</For>
          <For each={asm().patterns ?? []}>
            {(p) => <ExtraRow kind="pattern" id={p.id} name={p.name} icon={p.type === 'linear' ? 'pattern-linear' : 'pattern-circular'} suppressed={p.suppressed} tip={`${p.count} in all of ${p.of.length} ${p.of.length === 1 ? 'part' : 'parts'}`} openMenu={setMenu} />}
          </For>
          <For each={asm().replicates ?? []}>
            {(r) => <ExtraRow kind="replicate" id={r.id} name={r.name} icon="replicate" suppressed={r.suppressed} tip={`${copies().filter((c) => c.from === r.id).length} copies`} openMenu={setMenu} />}
          </For>
        </div>
      </section>
      <Show when={(asm().explodes ?? []).length || (asm().positions ?? []).length}>
        <section class="panel" aria-label="Views and positions">
          <Show when={(asm().explodes ?? []).length}>
            <h2>Exploded views</h2>
            <div class="asm-mates" data-testid="explodes">
              <For each={asm().explodes ?? []}>
                {(x) => (
                  <>
                    <ExtraRow kind="explode" id={x.id} name={x.name} icon="explode" tip={`${x.steps.length} ${x.steps.length === 1 ? 'step' : 'steps'}. Click to show it.`} openMenu={setMenu} on={shownExplode()?.id === x.id} click={() => showExplode(shownExplode()?.id === x.id ? null : x.id)} />
                    <Show when={shownExplode()?.id === x.id && !extraDraft()}>
                      <div class="asm-slider"><input type="range" min="0" max="1" step="0.01" value={shownExplode()!.amount} aria-label={`How far ${x.name} is exploded`} data-testid="explode-amount" onInput={(e) => showExplode(x.id, Number(e.currentTarget.value))} /></div>
                    </Show>
                  </>
                )}
              </For>
            </div>
          </Show>
          <Show when={(asm().positions ?? []).length}>
            <h2>Named positions</h2>
            <div class="asm-mates" data-testid="positions">
              <For each={asm().positions ?? []}>{(n) => <ExtraRow kind="position" id={n.id} name={n.name} icon="position" tip="Click to take the parts back there" openMenu={setMenu} click={() => goToPosition(n.id)} />}</For>
            </div>
          </Show>
        </section>
      </Show>
      <Show when={menu()}>{(m) => <ContextMenu {...m()} close={() => setMenu(null)} />}</Show>
    </>
  );
}

export function AssemblyStatus() {
  const text = () => (asmFreedom() === 0 ? 'Fully defined' : `${asmFreedom()} ${asmFreedom() === 1 ? 'freedom' : 'freedoms'} left`);
  return <Show when={asm().instances.length > 0}><div class="sketch-status" classList={{ done: asmFreedom() === 0 }} data-testid="assembly-status">{text()}</div></Show>;
}

function InsertDialog() {
  closeOnEscape(() => insertOpen(), () => setInsertOpen(false));
  return (
    <DialogFrame
      label="Insert parts"
      testid="insert-dialog"
      icon="insert"
      title="Insert parts"
      actions={<button class="dialog-action" aria-label="Close" data-tip="Close" data-keys="Esc" onClick={() => setInsertOpen(false)}><Icon name="close" /></button>}
    >
        <Show when={insertRows()} fallback={<p class="field-hint">Reading the Part Studios…</p>}>
          {(rows) => (
            <>
              <For each={rows()}>
                {(row) => (
                  <div class="insert-group" data-studio={row.tab}>
                    <button class="insert-row studio" disabled={!row.parts.length} data-tip={row.parts.length ? 'Insert all of its parts' : undefined} onClick={() => void insertParts(row.tab, null)}>
                      <Icon name="part-studio" />
                      <span class="feature-name">{row.name}</span>
                    </button>
                    <For each={row.parts}>
                      {(p) => (
                        <button class="insert-row part" data-part-body={p.body} onClick={() => void insertParts(row.tab, p.body)}>
                          <Icon name="part" />
                          <span class="feature-name">{p.label}</span>
                        </button>
                      )}
                    </For>
                    <Show when={row.error}><p class="dialog-error" role="alert">{row.error}</p></Show>
                    <Show when={!row.parts.length && !row.error}><p class="field-hint">No parts yet</p></Show>
                  </div>
                )}
              </For>
              <Show when={!rows().length}><p class="field-hint">This document has no Part Studios.</p></Show>
            </>
          )}
        </Show>
    </DialogFrame>
  );
}

function ConnectorWell(props: { label: string; which: 'first' | 'second' }) {
  const picked = () => mateDraft()?.[props.which] ?? null;
  const name = () => {
    const p = picked();
    const i = p && instanceById(p.instance);
    return i ? instanceName(i) : '';
  };
  return (
    <div class="field">
      <span class="field-label">{props.label}</span>
      <div class="pick-well" classList={{ waiting: !picked() }} data-testid={`mate-${props.which}`}>
        <Show when={picked()} fallback={<>Click a connector</>}>
          <span class="pick-text" data-tip={name()}>{name()}</span>
          <button class="link" onClick={() => updateDraft({ [props.which]: null })}>Clear</button>
        </Show>
      </div>
    </div>
  );
}

function MateDialog() {
  const d = () => mateDraft()!;
  const ready = () => !!d().first && !!d().second;
  /** A tangent mate's freedom depends on the faces: a ball on a plane has more than two planes face to face. */
  const dof = () => {
    if (d().type !== 'tangent') return MATE_DOF[d().type];
    const shape = (p: PickedConnector | null) => {
      const i = p && instanceById(p.instance);
      const part = i && partOf(i);
      return part ? shapeOf(part, p!.connector) ?? undefined : undefined;
    };
    return tangentFreedom(shape(d().first), shape(d().second));
  };
  return (
    <DialogFrame
      label="Mate"
      testid="mate-dialog"
      title={d().editing ? d().name : `${mateTypeName(d().type)} mate`}
      actions={
        <>
          <button class="dialog-action ok" disabled={!ready() || !!d().error} aria-label="Add mate" data-tip={d().editing ? 'Save' : 'Add mate'} data-keys="Enter" data-testid="mate-ok" onClick={acceptMate}><Icon name="check" /></button>
          <button class="dialog-action" aria-label="Cancel" data-tip="Cancel" data-keys="Esc" onClick={cancelMate}><Icon name="close" /></button>
        </>
      }
    >
        <div class="mate-types" role="radiogroup" aria-label="Mate type">
          <For each={MATE_TYPES}>
            {(t) => (
              <button class="mate-type" classList={{ on: d().type === t }} role="radio" aria-checked={d().type === t} aria-label={mateTypeName(t)} data-tip={mateTypeName(t)} data-mate-type={t} onClick={() => updateDraft({ type: t })}>
                <Icon name={mateIcon(t)} />
              </button>
            )}
          </For>
        </div>
        <p class="mate-dof">{WHAT_MOVES[d().type]}. {dof()} {dof() === 1 ? 'freedom' : 'freedoms'}.</p>
        <ConnectorWell label="First" which="first" />
        <ConnectorWell label="Second" which="second" />
        <div class="field">
          <span class="field-label">Align</span>
          <div class="mate-actions">
            <button class="mate-action" classList={{ on: d().flip }} disabled={!ready()} aria-label="Flip primary axis" aria-pressed={d().flip} data-tip="Flip primary axis" data-testid="mate-flip" onClick={() => updateDraft({ flip: !d().flip })}><Icon name="mate-flip" /></button>
            <button class="mate-action" disabled={!ready()} aria-label="Reorient secondary axis" data-tip="Reorient secondary axis" data-testid="mate-turn" onClick={() => updateDraft({ quarter: (d().quarter + 1) % 4 })}><Icon name="mate-turn" /></button>
          </div>
        </div>
        <Show when={d().error}><p class="dialog-error" role="alert" data-testid="mate-error">{d().error}</p></Show>
    </DialogFrame>
  );
}

const num = (s: string, fallback: number) => (Number.isFinite(Number(s)) && s.trim() !== '' ? Number(s) : fallback);

function NumberField(props: { label: string; value: number; unit?: string; testid: string; set: (v: number) => void }) {
  return (
    <label class="field">
      <span class="field-label">{props.label}</span>
      <span class="field-input">
        <input data-testid={props.testid} value={String(props.value)} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => props.set(num(e.currentTarget.value, props.value))} />
        <Show when={props.unit}><span class="unit">{props.unit}</span></Show>
      </span>
    </label>
  );
}

function PartsWell(props: { of: string[]; prompt: string }) {
  const active = () => !extraDraft()?.picking;
  return (
    <div class="pick-box" classList={{ waiting: !props.of.length, idle: !active() }} data-testid="extra-parts" onPointerDown={() => { const d = extraDraft(); if (d?.picking) setExtraDraft({ ...d, picking: false } as never); }}>
      <div class="pick-head"><span class="pick-label">Parts</span></div>
      <Show when={props.of.length} fallback={<div class="pick-prompt">{props.prompt}</div>}>
        <div class="pick-rows">
          <For each={props.of}>{(id) => <div class="pick-row"><span class="pick-name">{instanceById(id) ? instanceName(instanceById(id)!) : id}</span></div>}</For>
        </div>
      </Show>
    </div>
  );
}

function connectorWords(c: { instance: string; connector: ConnectorRef } | null) {
  if (!c) return null;
  const i = instanceById(c.instance);
  return `${c.connector.kind === 'edge' ? 'Edge' : 'Face'} of ${i ? instanceName(i) : 'a part'}`;
}

/** A pattern or replicate of parts, or an exploded view. */
function ExtraDialog() {
  const d = () => extraDraft()!;
  const title = () => d().item.name;
  return (
    <DialogFrame
      label={title()}
      testid="extra-dialog"
      icon={d().kind === 'pattern' ? (d().item as { type: string }).type === 'linear' ? 'pattern-linear' : 'pattern-circular' : d().kind}
      title={title()}
      actions={
        <>
          <button class="dialog-action ok" disabled={!!extraMissing()} aria-label="OK" data-tip={extraMissing() ?? 'OK'} data-keys="Enter" data-testid="extra-ok" onClick={acceptExtra}><Icon name="check" /></button>
          <button class="dialog-action" aria-label="Cancel" data-tip="Cancel" data-keys="Esc" onClick={cancelExtra}><Icon name="close" /></button>
        </>
      }
    >
      <Switch>
        <Match when={d().kind === 'pattern' && (d().item as import('./model').PatternData)}>
          {(p) => (
            <>
              <PartsWell of={p().of} prompt="Click the parts to copy" />
              <div class="segment" role="radiogroup" aria-label="Pattern type">
                <button classList={{ on: p().type === 'linear' }} onClick={() => updateExtra({ type: 'linear' })}>Linear</button>
                <button classList={{ on: p().type === 'circular' }} onClick={() => updateExtra({ type: 'circular' })}>Circular</button>
              </div>
              <div class="field">
                <span class="field-label">{p().type === 'linear' ? 'Direction' : 'Axis'}</span>
                <div class="segment" role="radiogroup" aria-label="Pattern axis" data-testid="pattern-axis">
                  <For each={['x', 'y', 'z'] as const}>{(a) => <button classList={{ on: p().axis === a }} data-axis={a} onClick={() => updateExtra({ axis: a }, false)}>{a.toUpperCase()}</button>}</For>
                  <button classList={{ on: typeof p().axis !== 'string' || d().picking }} data-axis="connector" onClick={() => updateExtra({}, true)}>Pick</button>
                </div>
              </div>
              <Show when={typeof p().axis !== 'string' || d().picking}>
                <p class="field-hint" data-testid="pattern-axis-pick">{d().picking ? 'Click a face or edge in the view: the pattern goes along its connector’s Z.' : `Along ${connectorWords(p().axis as { instance: string; connector: ConnectorRef })}, following it.`}</p>
              </Show>
              <Show when={p().type === 'linear'} fallback={<NumberField label="Angle" unit="°" value={p().degrees} testid="pattern-degrees" set={(v) => updateExtra({ degrees: v })} />}>
                <NumberField label="Distance" unit="mm" value={p().spacing} testid="pattern-spacing" set={(v) => updateExtra({ spacing: v })} />
              </Show>
              <NumberField label="Instances" value={p().count} testid="pattern-count" set={(v) => updateExtra({ count: Math.max(1, Math.round(v)) })} />
              <p class="field-hint">Copies follow the parts as their mates move them. They can't be mated themselves.</p>
            </>
          )}
        </Match>
        <Match when={d().kind === 'replicate' && (d().item as import('./model').ReplicateData)}>
          {(r) => {
            const places = () => {
              const t = r().target && instanceById(r().target);
              const part = t && partOf(t);
              return part && r().connector ? replicatePlaces(part, r().connector!).length : 0;
            };
            return (
              <>
                <PartsWell of={r().of} prompt="Click the parts to copy, such as a screw" />
                <div class="pick-box" classList={{ waiting: !r().connector, idle: !d().picking }} data-testid="replicate-target" onPointerDown={() => { if (!d().picking) setExtraDraft({ ...d(), picking: true } as never); }}>
                  <div class="pick-head"><span class="pick-label">Placed at</span></div>
                  <Show when={r().connector} fallback={<div class="pick-prompt">Click the face they're at, such as the hole a screw is in</div>}>
                    <div class="pick-rows"><div class="pick-row"><span class="pick-name">{connectorWords({ instance: r().target, connector: r().connector! })}</span></div></div>
                  </Show>
                </div>
                <Show when={r().connector}><p class="field-hint" data-testid="replicate-count">{places() ? `${places()} more ${places() === 1 ? 'place' : 'places'} like it, so ${places()} ${places() === 1 ? 'copy' : 'copies'} of each part.` : 'No other face of that part is like this one.'}</p></Show>
              </>
            );
          }}
        </Match>
        <Match when={d().kind === 'explode' && (d().item as import('./model').ExplodeData)}>
          {(x) => {
            const setStep = (i: number, change: object) => updateExtra({ steps: x().steps.map((s, k) => (k === i ? { ...s, ...change } : s)) });
            return (
              <>
                <For each={x().steps}>
                  {(s, i) => (
                    <div class="explode-step" data-step={i()}>
                      <div class="pick-head"><span class="pick-label">Step {i() + 1}: {s.instances.map((id) => (instanceById(id) ? instanceName(instanceById(id)!) : id)).join(', ')}</span><button class="link" aria-label={`Remove step ${i() + 1}`} onClick={() => updateExtra({ steps: x().steps.filter((_, k) => k !== i()) })}>Remove</button></div>
                      <div class="explode-shift">
                        <For each={[0, 1, 2]}>{(k) => <NumberField label={'XYZ'[k]} unit="mm" value={s.shift[k]} testid={`explode-${i()}-${'xyz'[k]}`} set={(v) => { const shift = [...s.shift] as [number, number, number]; shift[k] = v; setStep(i(), { shift }); }} />}</For>
                      </div>
                    </div>
                  )}
                </For>
                <button class="btn" data-testid="explode-add" disabled={!selectedInstances().length} onClick={() => updateExtra({ steps: [...x().steps, { instances: [...selectedInstances()], shift: [0, 0, 30] }] })}>Add a step for the {selectedInstances().length || ''} selected</button>
                <Show when={shownExplode()}>
                  <label class="field"><span class="field-label">Show</span><input type="range" min="0" max="1" step="0.01" value={shownExplode()!.amount} data-testid="explode-preview" onInput={(e) => showExplode(x().id, Number(e.currentTarget.value))} /></label>
                </Show>
                <p class="field-hint">Each step moves its parts after the one before. Only the view moves: the parts stay where their mates put them.</p>
              </>
            );
          }}
        </Match>
      </Switch>
    </DialogFrame>
  );
}

/** What floats over an assembly's view. */
export function AssemblyDialogs() {
  return (
    <>
      <Show when={mateDraft()}><MateDialog /></Show>
      <Show when={extraDraft() && !mateDraft()}><ExtraDialog /></Show>
      <Show when={insertOpen() && !mateDraft() && !extraDraft()}><InsertDialog /></Show>
    </>
  );
}

export function AssemblyEmpty() {
  return (
    <Show when={!asm().instances.length && !insertOpen()}>
      <div class="empty" data-testid="assembly-empty">
        <p>This assembly is empty.</p>
        <button class="link asm-empty-link" onClick={() => void openInsert()}>Insert a part from a Part Studio</button>
      </div>
    </Show>
  );
}

