import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { booted, busy, doc, stopEngine, volumeError, work } from '../store/doc';
import { importRunning, progressWords } from '../store/imports';
import { glProblem, hoverText, mode } from '../store/ui';
import { session } from '../sketch/controller';
import { CONSTRAINT_NEEDS } from '../sketch/session';
import { asmHint } from '../assembly/interaction';
import { inAssembly, inDrawing } from '../store/tabs';
import { activeDef, pickKind, regionsTakeFaces } from '../features/dialog';
import { Icon } from './icons';

const n = (v: number, digits = 2) => v.toLocaleString('en', { maximumFractionDigits: digits });

function hint() {
  if (glProblem()) return '';
  const s = session();
  if (s) {
    const waiting = s.constraintTool[0]();
    if (waiting) return `${CONSTRAINT_NEEDS[waiting]}: click them, and it's added as soon as they fit. Part corners and edges count too. Esc stops.`;
    switch (s.tool[0]()) {
      case 'select': return 'Drag geometry or a dimension to move it, double-click a dimension to change it. Right-click for Normal to sketch plane.';
      case 'line': return 'Click to start, click to continue. Lines snap to right angles and show an icon. Hold Shift to ignore snaps. Esc ends the chain.';
      case 'rect': return 'Click one corner, then the other.';
      case 'rect-center': return 'Click the center, then a corner.';
      case 'circle': return 'Click the center, then the rim.';
      case 'circle-3pt': return 'Click three points the circle passes through.';
      case 'arc-tangent': return 'Click the end of a line or arc, then where the arc should finish.';
      case 'arc': return 'Click where it starts, where it ends, then a point it passes through.';
      case 'arc-center': return 'Click the center, then the start, then the end, going counter-clockwise.';
      case 'mirror': return s.mirrorLine[0]() === null ? 'Click the line to mirror about. Whatever was selected is mirrored as soon as it’s clicked.' : 'Click curves to mirror them about the line. Esc picks another line.';
      case 'slot': return 'Click one end of the slot’s centre line, then the other, then how wide it is.';
      case 'polygon': return `Click the center, then a corner. ${s.polygonSides[0]()} sides: + and − change it.`;
      case 'spline': return 'Click points for the curve to pass through. Press Enter or click the last point again to finish.';
      case 'point': return 'Click to place a point.';
      case 'text': return 'Click where the text starts, then type it. Shift Enter starts a new line; its height is a dimension.';
      case 'trim': return 'Click a piece of a curve to remove it, up to where it crosses something.';
      case 'sketch-fillet': return 'Click the corner where two lines meet, then type the radius.';
      case 'extend': return 'Click near the end of a line or arc to carry it on to the first thing it meets.';
      case 'offset': return 'Click a curve: everything joined to it end to end comes too. Then move to set how far and to which side, and click. Shift moves freely.';
      case 'sketch-linear':
      case 'sketch-circular': {
        const p = s.pattern[0]();
        if (s.pickingCenter[0]()) return 'Click the point to turn the copies about: the origin, a point, an end or a center.';
        if (!p?.ids.length) return 'Click the curves to copy, or select them first.';
        return `${p.count} in all: + and − change how many. Click more curves to add them, and press Enter to make the pattern.`;
      }
      case 'dimension': return 'Click something to see its size, pull it where you want it, and click. Click a second thing to measure between them.';
    }
  }
  if (mode() === 'pick-plane') return '';
  if (inAssembly()) return asmHint();
  if (inDrawing()) return 'Wheel zooms the sheet, drag moves it and double-click fits it. The drawing follows the model: change the part and come back.';
  if (pickKind() === 'regions') return `Click ${regionsTakeFaces() ? 'a flat face or a region' : 'a region'} to add it or drop it, or a sketch in the list for all of it. Right drag rotates, middle drag pans.`;
  if (pickKind() === 'sections') return 'Click profiles in the order the loft passes through them: regions in the view, or sketches in the list. Right drag rotates, middle drag pans.';
  if (pickKind() === 'features') return 'Click a feature in the list, or a face it made in the view, to add it or drop it. Right drag rotates, middle drag pans.';
  if (pickKind() === 'axis') return 'Click a line of the sketch to turn around it. Right drag rotates, middle drag pans.';
  if (pickKind() === 'plane' || pickKind() === 'planes') return 'Click a plane or a flat face, in the view or in the list. Click it again to drop it. Right drag rotates, middle drag pans.';
  if (pickKind() === 'point' || pickKind() === 'points') return 'Point at a corner of the part, a point of a sketch or the origin, and click when it’s ringed. Right drag rotates, middle drag pans.';
  if (pickKind() === 'line') return 'Click a straight edge or a sketch line, or something round for its axis. Right drag rotates, middle drag pans.';
  if (pickKind()) return 'Click to pick, click again to drop it, or drag a box. Right drag rotates, middle drag pans.';
  if (activeDef()) return 'The preview updates as you type. Dimensions can be expressions, like width / 2.';
  return 'Right drag rotates, middle drag pans, scroll zooms. Click to select, right-click for options, ? for keys.';
}

export function StatusBar() {
  const [slow, setSlow] = createSignal(false);
  createEffect(() => {
    if (!busy()) return setSlow(false);
    const t = setTimeout(() => setSlow(true), 700);
    onCleanup(() => clearTimeout(t));
  });
  const size = () => {
    const s = doc.solid;
    if (!s) return '';
    return [0, 1, 2].map((i) => n(s.bounds_max[i] - s.bounds_min[i], 1)).join(' × ');
  };
  return (
    <footer class="statusbar" data-testid="status">
      <span class="status-left">{hoverText() || hint()}</span>
      <Show when={doc.failed}><span class="status-failed" title={doc.failed!}><Icon name="warn" size={13} />{doc.failed}</span></Show>
      <Show when={doc.solid && !doc.solid.valid}><span class="status-failed"><Icon name="warn" size={13} />This solid failed its checks</span></Show>
      <span class="status-right">
        <Show when={doc.solid}>
          <span data-testid="volume" classList={{ 'status-rough': volumeError() !== null }} data-tip={volumeError() !== null ? `Only good to within ${n(volumeError()!)} mm³: an edge where faces meet nearly tangent can’t be traced closely enough to measure it` : undefined}>
            <Show when={volumeError() !== null}><Icon name="warn" size={12} /></Show><b>{n(doc.solid!.volume)}</b>{volumeError() !== null ? ` ± ${n(volumeError()!)}` : ''} mm³
          </span>
          <span><b>{n(doc.solid!.area)}</b> mm²</span>
          <span><b>{size()}</b> mm</span>
          <span><b>{doc.solid!.faces}</b> faces</span>
        </Show>
        {/* A long rebuild says what it's on, as opening a document with a large import in it does. The import card says it for an import. */}
        <Show when={slow() && !importRunning() && progressWords(work())}>
          <span class="status-work" data-testid="status-work">
            <span class="status-work-bar"><span style={{ width: `${work()!.total > 0 ? (100 * work()!.done) / work()!.total : 0}%` }} /></span>
            {booted() ? '' : 'Opening · '}{progressWords(work())}
          </span>
        </Show>
        <Show when={slow()} fallback={<span class="status-time">{doc.ms} ms</span>}>
          <button class="btn stop" onClick={stopEngine}><Icon name="stop" size={11} />Stop rebuild</button>
        </Show>
      </span>
    </footer>
  );
}
