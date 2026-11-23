/** What faces, edges and sizes are called on screen, rather than the kernel's names for them. */
export const fmtNum = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString('en', { maximumFractionDigits: 1 }) : String(Number(v.toFixed(2))));

const surfaceWords: Record<string, string> = { plane: 'Flat face', cylinder: 'Cylindrical face', cone: 'Conical face', sphere: 'Spherical face', torus: 'Toroidal face' };
const curveWords: Record<string, string> = { line: 'Straight edge', circle: 'Round edge', ellipse: 'Elliptical edge', traced: 'Curved edge', spline: 'Spline edge' };

export const faceWord = (surface?: string) => (surface && surfaceWords[surface]) || 'Curved face';
export const edgeWord = (curve?: string) => (curve && curveWords[curve]) || 'Edge';

type PartRow = { name: string; label?: string; sheet: boolean };
const labelTables = new WeakMap<PartRow[], Map<string, string>>();

/** Every part's label at once, worked out once per list: a 2,218-part import asked for each one by one was slow. */
function labelTable(parts: PartRow[]) {
  let table = labelTables.get(parts);
  if (table) return table;
  table = new Map();
  const uses = new Map<string, number>();
  for (const p of parts) if (p.label) uses.set(p.label, (uses.get(p.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  let solids = 0;
  let sheets = 0;
  for (const p of parts) {
    const n = p.sheet ? ++sheets : ++solids;
    if (p.label) {
      // A file can use one name for many parts, as an assembly's 40 profiles of one frame: each gets a number.
      const k = (seen.get(p.label) ?? 0) + 1;
      seen.set(p.label, k);
      table.set(p.name, uses.get(p.label)! > 1 ? `${p.label} (${k})` : p.label);
    } else table.set(p.name, `${p.sheet ? 'Surface' : 'Part'} ${n}`);
  }
  labelTables.set(parts, table);
  return table;
}

/**
 * What a part is called on screen: the name given to it, the name it had in a file it came from, or Part 2, or
 * Surface 1 for a sheet, numbered by kind in the order they were made.
 */
export function partLabel(parts: PartRow[], name: string, looks?: Record<string, { name?: string }>) {
  if (looks?.[name]?.name) return looks[name].name!;
  return labelTable(parts).get(name) ?? name;
}
