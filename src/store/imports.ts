import { createSignal } from 'solid-js';
import type { Progress } from '../engine/client';

/**
 * A file being brought into the Part Studio, as Onshape shows a translation: what it's doing, for how long, and what
 * went wrong if it didn't work. The kernel says how far it's got as it goes, stage by stage.
 */
export type ImportStage = 'reading' | 'translating' | 'drawing' | 'done' | 'failed' | 'stopped';
export interface ImportJob {
  name: string;
  bytes: number;
  stage: ImportStage;
  /** How much of the file has come off the disk, from 0 to 1. */
  read: number;
  started: number;
  /** When the kernel took it, to time that part. */
  translating?: number;
  ended?: number;
  /** Solids the file says it holds, counted before the kernel reads it. */
  solids?: number;
  parts?: number;
  error?: string;
  /** What to try instead, if there's something. */
  hint?: string;
  /** What the kernel last said it was doing, while it translates. */
  kernel?: Progress;
  /** The bar, from 0 to 1. It never goes back. */
  bar: number;
  /** Solids the kernel left out, each with why, and those it had to repair. */
  leftOut?: string[];
  repaired?: string[];
}

/**
 * Where a stage of the kernel's work puts the bar. Parsing is quick and building the solids is most of it; measuring
 * every part for the summary comes after. The kernel's own rebuild count is the features around the import, which
 * take no time worth showing, so it doesn't move the bar.
 */
const SPAN: Record<string, [number, number]> = {
  parsing: [0.05, 0.15],
  solids: [0.15, 0.7],
  measuring: [0.7, 0.9],
};
export function barFor(j: ImportJob, p?: Progress) {
  if (j.stage === 'reading') return j.read * 0.05;
  if (j.stage === 'drawing') return Math.max(j.bar, 0.9);
  if (j.stage === 'done') return 1;
  const span = p && SPAN[p.stage];
  if (!span) return j.bar;
  const f = p.total > 0 ? Math.min(1, p.done / p.total) : 1;
  return Math.max(j.bar, span[0] + (span[1] - span[0]) * f);
}

export const [importJob, setImportJob] = createSignal<ImportJob | null>(null);
export const importRunning = () => {
  const s = importJob()?.stage;
  return s === 'reading' || s === 'translating' || s === 'drawing';
};
export const updateImport = (patch: Partial<ImportJob>) =>
  setImportJob((j) => {
    if (!j) return j;
    const next = { ...j, ...patch };
    return { ...next, bar: barFor(next, patch.kernel) };
  });

/** What the kernel says it's on, in words: for the import card, and for the status bar on any long rebuild. */
export function progressWords(p: Progress | null | undefined): string | null {
  const pct = p && p.total > 0 ? Math.round((100 * p.done) / p.total) : 0;
  switch (p?.stage) {
    case 'parsing': return `Reading the geometry · ${pct}%`;
    case 'solids': return `Building the solids · ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`;
    case 'measuring': return `Measuring the parts · ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`;
    case 'rebuild': return p.total > 1 ? `Rebuilding · feature ${Math.min(p.done + 1, p.total)} of ${p.total}` : null;
    default: return null;
  }
}
