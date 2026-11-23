import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { cancelImport, importStep } from '../files';
import { importJob, importRunning, progressWords, setImportJob, type ImportJob } from '../store/imports';
import { Icon } from './icons';

const size = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

const TITLE: Record<ImportJob['stage'], string> = {
  reading: 'Importing',
  translating: 'Importing',
  drawing: 'Importing',
  done: 'Imported',
  failed: 'Couldn’t import',
  stopped: 'Import stopped',
};

/**
 * How an import is going, as Onshape shows a translation: the file, a bar, what it's on and for how long, and a way to
 * stop it. When it's done it says what came in, and when it fails it says why, and stays until it's closed.
 */
export function ImportCard() {
  const [now, setNow] = createSignal(performance.now());
  createEffect(() => {
    if (!importRunning()) return;
    setNow(performance.now());
    const t = setInterval(() => setNow(performance.now()), 250);
    onCleanup(() => clearInterval(t));
  });
  // A finished import goes by itself after a moment, as a stopped one does. A failure waits to be read.
  createEffect(() => {
    const j = importJob();
    // One that left solids out stays, so what's missing can be read.
    if (!j || (j.stage !== 'done' && j.stage !== 'stopped') || j.leftOut?.length) return;
    const t = setTimeout(() => setImportJob((x) => (x === j ? null : x)), j.stage === 'done' ? 5000 : 2500);
    onCleanup(() => clearTimeout(t));
  });

  /** What the kernel is on, in its own counts. */
  const kernelLine = (j: ImportJob) => {
    if (j.kernel?.stage === 'solids') return `Building the solids · ${j.kernel.done.toLocaleString()} of ${count(j.kernel.total, 'solid')}`;
    return (j.kernel && progressWords(j.kernel)) || `Translating the geometry${j.solids ? ` · ${count(j.solids, 'solid')}` : ''}`;
  };
  const line = (j: ImportJob) => {
    switch (j.stage) {
      case 'reading': return `Reading the file · ${Math.round(j.read * 100)}%`;
      case 'translating': return kernelLine(j);
      case 'drawing': return 'Drawing the parts';
      case 'done': {
        const out = j.leftOut?.length ? `, ${count(j.leftOut.length, 'solid')} left out` : '';
        return `${count(j.parts ?? 0, 'part')} added in ${clock((j.ended ?? now()) - j.started)}${out}`;
      }
      case 'stopped': return 'Nothing was added.';
      default: return '';
    }
  };
  /** The bar, from what the kernel says. Before it has said anything about a file, a moving stripe. */
  const fraction = (j: ImportJob) => (j.stage === 'translating' && !j.kernel ? null : j.bar);

  return (
    <Show when={importJob()}>
      {(j) => (
        <section class="import-card" classList={{ failed: j().stage === 'failed' }} role="status" aria-live="polite" data-testid="import-card" data-stage={j().stage}>
          <header class="import-head">
            <Show when={j().stage === 'failed'} fallback={<Icon name={j().stage === 'done' ? 'check' : 'import'} size={14} />}>
              <Icon name="warn" size={14} />
            </Show>
            <h2>{TITLE[j().stage]}</h2>
            <Show when={importRunning()} fallback={<button class="mini" aria-label="Close" data-tip="Close" onClick={() => setImportJob(null)}><Icon name="close" /></button>}>
              <span class="import-time" data-testid="import-time">{clock(now() - j().started)}</span>
            </Show>
          </header>
          <div class="import-body">
            <p class="import-file" title={j().name}>
              <span class="import-name">{j().name}</span>
              <span class="import-size">{size(j().bytes)}</span>
            </p>
            <Show when={j().stage !== 'failed'}>
              <Show when={j().stage !== 'stopped'}>
                <div class="import-bar" classList={{ moving: fraction(j()) === null }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fraction(j()) === null ? undefined : Math.round(fraction(j())! * 100)}>
                  <span style={{ width: fraction(j()) === null ? undefined : `${fraction(j())! * 100}%` }} />
                </div>
              </Show>
              <p class="import-line" data-testid="import-line">{line(j())}</p>
              <Show when={j().stage === 'translating' && j().bytes > 20e6 && now() - (j().translating ?? now()) > 8000}>
                <p class="import-note">A file this size can take a minute or two. You can still turn the view; changes wait until it’s in.</p>
              </Show>
              <Show when={j().stage === 'done' && j().leftOut?.length}>
                <details class="import-left" data-testid="import-left" open={j().leftOut!.length <= 3}>
                  <summary>Left out, and why</summary>
                  <ul>{j().leftOut!.map((n) => <li>{n}</li>)}</ul>
                  <p class="import-note">Exporting those parts again from their own program often repairs them.</p>
                </details>
              </Show>
              <Show when={j().stage === 'done' && j().repaired?.length}>
                <p class="import-note" data-testid="import-repaired">{count(j().repaired!.length, 'solid')} had faces meeting at a single point, and came in with a corner for each.</p>
              </Show>
            </Show>
            <Show when={j().stage === 'failed'}>
              <p class="import-error" data-testid="import-error">{j().error}</p>
              <Show when={j().hint}><p class="import-note">{j().hint}</p></Show>
            </Show>
            <div class="import-actions">
              <Show when={importRunning()}>
                <button class="btn" data-testid="import-stop" onClick={cancelImport}>Stop</button>
              </Show>
              <Show when={j().stage === 'failed'}>
                <button class="btn" onClick={() => setImportJob(null)}>Close</button>
                <button class="btn primary" onClick={() => void importStep()}>Choose another file</button>
              </Show>
            </div>
          </div>
        </section>
      )}
    </Show>
  );
}
