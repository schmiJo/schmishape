import { createMemo, createSignal, For, Show } from 'solid-js';
import { MATERIALS, meshMass, type MassProps } from '../features/mass';
import { fmtNum, partLabel } from '../features/words';
import { doc, mesh, partLooks, setPartsMaterial, volumeError, type ToolError } from '../store/doc';
import { selectedPart, selection, toast } from '../store/ui';
import { Icon } from './icons';

export const [massOpen, setMassOpen] = createSignal(false);

const density = (material?: string) => MATERIALS.find((m) => m.name === material)?.density ?? null;

/**
 * Onshape's mass properties: for the parts selected, or every part, their volume, area and, with a material, mass,
 * with the centre of mass and the moments of inertia about it.
 */
export function MassPanel() {
  const m = () => mesh();
  /** The parts it's about: those with a face selected, or the one picked in the list, or every solid part. */
  const scope = createMemo(() => {
    const parts = (m()?.parts ?? []).map((p, i) => ({ ...p, i })).filter((p) => !p.sheet);
    const sel = selection();
    const chosen = selectedPart() !== null ? parts.filter((p) => p.i === selectedPart()) : parts.filter((p) => p.faces.some((f) => sel.faces.includes(f)));
    return { parts: chosen.length ? chosen : parts, all: !chosen.length };
  });
  const props = createMemo(() => {
    const mm = m();
    if (!mm) return null;
    const looks = partLooks();
    const each = scope().parts.map((p) => ({ p, mass: meshMass(mm, new Set(p.faces)), rho: density(looks[p.name]?.material) }));
    const ok = each.filter((x): x is typeof x & { mass: MassProps } => !!x.mass);
    if (!ok.length) return null;
    // Weighted by mass where every part has a material, and by volume where some don't.
    const allMaterial = ok.every((x) => x.rho !== null);
    const w = (x: (typeof ok)[number]) => x.mass.volume * (allMaterial ? x.rho! * 1e-3 : 1);
    const total = ok.reduce((t, x) => t + w(x), 0);
    const center = [0, 1, 2].map((k) => ok.reduce((t, x) => t + w(x) * x.mass.center[k], 0) / total) as [number, number, number];
    // Each part's inertia, moved to the shared centre of mass.
    const inertia = [0, 1, 2].map((i) => [0, 1, 2].map((j) => ok.reduce((t, x) => {
      const d = [0, 1, 2].map((k) => x.mass.center[k] - center[k]);
      const shift = (i === j ? d[0] * d[0] + d[1] * d[1] + d[2] * d[2] : 0) - d[i] * d[j];
      const k = allMaterial ? x.rho! * 1e-3 : 1;
      return t + k * (x.mass.inertia[i][j] + x.mass.volume * shift);
    }, 0)));
    const volume = ok.reduce((t, x) => t + x.mass.volume, 0);
    const mass = allMaterial ? ok.reduce((t, x) => t + x.mass.volume * x.rho! * 1e-3, 0) : null;
    return { volume, mass, center, inertia, allMaterial };
  });
  // Exact figures from the kernel when it's about every part.
  const volume = () => (scope().all && doc.solid ? doc.solid.volume : props()?.volume ?? 0);
  const materials = () => [...new Set(scope().parts.map((p) => partLooks()[p.name]?.material ?? ''))];
  const setMaterial = (name: string) => setPartsMaterial(scope().parts.map((p) => p.name), name || null).catch((e) => toast((e as ToolError).message, 'error'));
  /** The mesh is a close copy of the part. With the kernel's exact volume to hand, mass and inertia are scaled to it. */
  const exact = () => (props() ? volume() / props()!.volume : 1);
  const massText = (g: number) => (g >= 1000 ? `${fmtNum(g / 1000)} kg` : `${fmtNum(g)} g`);
  const unit = () => (props()?.allMaterial ? 'g·mm²' : 'mm⁵');
  return (
    <section class="mass-panel" aria-label="Mass properties" data-testid="mass-panel">
      <header class="flat-head">
        <h2>Mass properties</h2>
        <button class="mini" aria-label="Close mass properties" data-tip="Close" onClick={() => setMassOpen(false)}><Icon name="close" /></button>
      </header>
      <div class="mass-body">
        <p class="mass-scope" data-testid="mass-scope">
          {scope().all ? `All parts (${scope().parts.length})` : scope().parts.map((p) => partLabel(m()?.parts ?? [], p.name, partLooks())).join(', ')}
        </p>
        <label class="mass-material">
          <span class="field-label">Material</span>
          <select class="select" data-testid="mass-material" value={materials().length === 1 ? materials()[0] : ''} onChange={(e) => setMaterial(e.currentTarget.value)}>
            <option value="" selected={materials().length === 1 && !materials()[0]}>{materials().length > 1 ? 'Several' : 'None'}</option>
            <For each={MATERIALS}>{(x) => <option value={x.name} selected={materials().length === 1 && materials()[0] === x.name}>{x.name} ({x.density} g/cm³)</option>}</For>
          </select>
        </label>
        <Show when={props()} fallback={<p class="flat-empty">No solid part to measure.</p>}>
          {(p) => (
            <dl class="mass-facts">
              <dt>Mass</dt><dd data-fact="mass">{p().mass !== null ? massText(p().mass! * exact()) : 'No material'}</dd>
              <dt>Volume</dt><dd data-fact="volume">{fmtNum(volume())}{scope().all && volumeError() !== null ? ` ± ${fmtNum(volumeError()!)}` : ''} mm³</dd>
              <dt>Center of mass</dt>
              <dd data-fact="center">{p().center.map((c) => fmtNum(c)).join(', ')} mm</dd>
              <dt class="mass-wide">Moments of inertia, about the center of mass, {unit()}</dt>
              <dd class="mass-wide">
                <table class="mass-tensor">
                  <tbody>
                    <For each={['x', 'y', 'z']}>
                      {(a, i) => (
                        <tr>
                          <For each={['x', 'y', 'z']}>{(b, j) => <td data-tip={`L${a}${b}`}>{fmtNum(p().inertia[i()][j()] * exact())}</td>}</For>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </dd>
            </dl>
          )}
        </Show>
      </div>
    </section>
  );
}
