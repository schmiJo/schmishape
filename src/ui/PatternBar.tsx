import { Show } from 'solid-js';
import { fmtNum } from '../features/words';
import { session } from '../sketch/controller';
import { Icon } from './icons';

/** A number field that takes what's typed when it's left or Enter is pressed. */
function Field(props: { label: string; unit?: string; value: number; set: (v: number) => void; testid: string; width?: number }) {
  return (
    <label class="pattern-field" style={{ width: `${props.width ?? 76}px` }}>
      <span class="pattern-label">{props.label}</span>
      <input
        value={fmtNum(props.value)}
        aria-label={props.label}
        data-testid={props.testid}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            const v = Number(e.currentTarget.value.replace(/,/g, ''));
            if (Number.isFinite(v)) props.set(v);
            session()?.commitPattern();
          }
          if (e.key === 'Escape') e.currentTarget.blur();
        }}
        onChange={(e) => {
          const v = Number(e.currentTarget.value.replace(/,/g, ''));
          if (Number.isFinite(v)) props.set(v);
          else e.currentTarget.value = fmtNum(props.value);
        }}
      />
      <Show when={props.unit}><span class="unit">{props.unit}</span></Show>
    </label>
  );
}

/** A sketch pattern's settings, across the top of the view while it's being set up, as Onshape's dialog has them. */
export function PatternBar() {
  return (
    <Show when={session()?.pattern[0]()}>
      {(p) => {
        const s = session()!;
        const centerName = () => (p().center === 'origin' ? 'Origin' : 'Picked point');
        return (
          <div class="section-bar pattern-bar" role="toolbar" aria-label={p().kind === 'linear' ? 'Linear pattern' : 'Circular pattern'} data-testid="pattern-bar" onPointerDown={(e) => e.stopPropagation()}>
            <span class="section-title">{p().kind === 'linear' ? 'Linear pattern' : 'Circular pattern'}</span>
            <span class="pattern-picked" data-testid="pattern-picked">{p().ids.length ? `${p().ids.length} ${p().ids.length === 1 ? 'curve' : 'curves'}` : 'Click curves'}</span>
            <Field label="Count" value={p().count} set={(v) => s.setPattern({ count: v })} testid="pattern-count" width={64} />
            <Show
              when={p().kind === 'linear'}
              fallback={
                <>
                  <Field label="Angle" unit="°" value={p().angle} set={(v) => s.setPattern({ angle: v })} testid="pattern-angle" />
                  <button class="link pattern-center" classList={{ on: s.pickingCenter[0]() }} data-tip="Click to pick the point the copies turn about" data-testid="pattern-center" onClick={() => s.pickingCenter[1](!s.pickingCenter[0]())}>
                    {s.pickingCenter[0]() ? 'Click a point…' : `About: ${centerName()}`}
                  </button>
                </>
              }
            >
              <Field label="Across" unit="mm" value={p().dx} set={(v) => s.setPattern({ dx: v })} testid="pattern-dx" />
              <Field label="Up" unit="mm" value={p().dy} set={(v) => s.setPattern({ dy: v })} testid="pattern-dy" />
            </Show>
            <button class="mini" aria-label="Make the pattern" data-tip="Make the pattern (Enter)" disabled={!p().ids.length} data-testid="pattern-ok" onClick={() => s.commitPattern()}><Icon name="check" /></button>
            <button class="mini" aria-label="Close the pattern" data-tip="Close" onClick={() => s.setTool('select')}><Icon name="close" /></button>
          </div>
        );
      }}
    </Show>
  );
}
