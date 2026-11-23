import '@fontsource-variable/inter/wght.css';
import './styles.css';
import { wholeText } from './engine/blobs';
import { ErrorBoundary } from 'solid-js';
import { render } from 'solid-js/web';
import { engine } from './engine/client';
import { setValue as dialogSetValue, startFeature } from './features/dialog';
import { doc, documentText, mesh, mutate, pushUndo, sketchRegions, stopEngine } from './store/doc';
import * as assembly from './assembly/store';
import * as tabs from './store/tabs';
import * as drawing from './drawing/store';
import { session } from './sketch/controller';
import { view } from './viewport/instance';
import { selectedRegions, selection, setSelection, toast } from './store/ui';
import { App, Crashed } from './ui/App';
import { Tooltip } from './ui/Tooltip';
import { sheetParts } from './store/sheetmetal';

// The same tool API the UI uses, for scripts and the console.
(window as any).schmishape = { dialogSetValue, engine, stopEngine, wholeText, doc, documentText, mesh, mutate, pushUndo, sketchRegions, sheetParts, startFeature, tabs, assembly, drawing, view, session, selection, setSelection, selectedRegions };

// Nothing should fail silently. Whatever nobody caught says so on screen.
const report = (message: string) => {
  if (!message.startsWith('ResizeObserver')) toast(`Something went wrong. ${message}`, 'error');
};
window.addEventListener('error', (e) => report(e.message));
window.addEventListener('unhandledrejection', (e) => report(e.reason?.message ?? String(e.reason)));

render(
  () => (
    <ErrorBoundary fallback={(error) => <Crashed error={error} />}>
      <App />
      <Tooltip />
    </ErrorBoundary>
  ),
  document.getElementById('root')!,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
