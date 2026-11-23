import { createSignal, For, Show } from 'solid-js';
import { saveWholeDocument } from '../files';
import { toast } from '../store/ui';
import { createVersion, deleteVersion, nextVersionName, restoreVersion, setVersionsOpen, versions, type VersionInfo } from '../store/versions';
import { Icon } from './icons';

const when = (t: number) => new Date(t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Onshape's Versions: the document as it stood, by name. Each one can be restored, which keeps the document as it is now
 * as a version first, saved as a file, or deleted.
 */
export function VersionsPanel() {
  const [name, setName] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  /** The version a Restore or Delete is waiting on a second click for, and which. */
  const [asking, setAsking] = createSignal<{ id: string; what: 'restore' | 'delete' } | null>(null);

  const create = async () => {
    setBusy(true);
    try {
      const v = await createVersion(name() || nextVersionName(), description());
      setName('');
      setDescription('');
      toast(`Version ${v.name} created`);
    } catch (e) {
      toast(`The version couldn't be created. ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  const act = async (v: VersionInfo, what: 'restore' | 'delete') => {
    setAsking(null);
    setBusy(true);
    try {
      if (what === 'restore') await restoreVersion(v.id);
      else {
        await deleteVersion(v.id);
        toast(`Version ${v.name} deleted`);
      }
    } catch (e) {
      toast(`${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="mass-panel versions-panel" aria-label="Versions" data-testid="versions-panel">
      <header class="flat-head">
        <h2>Versions</h2>
        <button class="mini" aria-label="Close versions" data-tip="Close" onClick={() => setVersionsOpen(false)}><Icon name="close" /></button>
      </header>
      <div class="versions-body">
        <form class="version-new" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <label class="field">
            <span class="field-label">Name</span>
            <input class="input" value={name()} placeholder={nextVersionName()} aria-label="Version name" data-testid="version-name" onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => e.stopPropagation()} />
          </label>
          <label class="field">
            <span class="field-label">Description</span>
            <textarea class="input" rows={2} value={description()} aria-label="Version description" data-testid="version-description" onInput={(e) => setDescription(e.currentTarget.value)} onKeyDown={(e) => e.stopPropagation()} />
          </label>
          <button class="btn primary" type="submit" disabled={busy()} data-testid="version-create">Create version</button>
          <p class="field-hint">A version keeps every tab as it is now. It lives in this browser: save the document to a file to keep it anywhere else.</p>
        </form>
        <Show when={versions().length} fallback={<p class="flat-empty">No versions yet.</p>}>
          <ol class="version-list" data-testid="version-list">
            <For each={versions()}>
              {(v) => (
                <li class="version" classList={{ auto: v.auto }} data-version={v.name}>
                  <div class="version-head">
                    <Icon name={v.auto ? 'undo' : 'versions'} size={12} />
                    <span class="version-name">{v.name}</span>
                    <span class="version-time">{when(v.created)}</span>
                  </div>
                  <Show when={v.description}><p class="version-description">{v.description}</p></Show>
                  <Show
                    when={asking()?.id === v.id}
                    fallback={
                      <div class="version-actions">
                        <button class="link" disabled={busy()} data-action="restore" onClick={() => setAsking({ id: v.id, what: 'restore' })}>Restore</button>
                        <button class="link" disabled={busy()} data-action="save" onClick={() => void saveWholeDocument(v)}>Save to file</button>
                        <button class="link" disabled={busy()} data-action="delete" onClick={() => setAsking({ id: v.id, what: 'delete' })}>Delete</button>
                      </div>
                    }
                  >
                    <div class="version-confirm" role="alert">
                      <p>{asking()!.what === 'restore' ? `Replace the whole document with ${v.name}? The document as it is now is kept as a version first.` : `Delete ${v.name}? This can't be undone.`}</p>
                      <div class="version-actions">
                        <button class="btn primary" data-action="confirm" onClick={() => void act(v, asking()!.what)}>{asking()!.what === 'restore' ? 'Restore' : 'Delete'}</button>
                        <button class="btn" onClick={() => setAsking(null)}>Cancel</button>
                      </div>
                    </div>
                  </Show>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </div>
    </section>
  );
}
