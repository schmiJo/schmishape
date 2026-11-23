import type { Frame, MateType, Pose } from './solver';

/**
 * What an Assembly tab keeps. Parts are referred to by their Part Studio's tab and the kernel's body name, and connectors
 * by the kernel's stable name for a face or edge, so they follow the part when it changes.
 */
export interface ConnectorRef {
  /** On a face or an edge, or midway between two parallel flat faces, as a width mate takes them. */
  kind: 'face' | 'edge' | 'between';
  /** A face's key or an edge's name, or for `between` the two faces' keys as `a|b`. */
  ref: string;
  /** Which of that entity's inference points. */
  how: string;
  /** Where it was last, in the part's own coordinates. */
  frame: Frame;
}

export interface InstanceData {
  id: string;
  tab: string;
  body: string;
  /** The n in "Part 1 <n>". */
  number: number;
  /** A name given by hand, if any. */
  name: string | null;
  pose: Pose;
  fixed: boolean;
  hidden: boolean;
}

export interface MateData {
  id: string;
  name: string;
  type: MateType;
  /** The first and second connectors picked, and the instances they're on. */
  a: string;
  b: string;
  ca: ConnectorRef;
  cb: ConnectorRef;
  flip: boolean;
  quarter: number;
  suppressed: boolean;
}

/** Copies of instances in a row or round an axis, placed after the mates are solved so they follow their instances. */
export interface PatternData {
  id: string;
  name: string;
  of: string[];
  type: 'linear' | 'circular';
  /** X, Y or Z through the origin, or a connector's Z, which follows its part. */
  axis: 'x' | 'y' | 'z' | { instance: string; connector: ConnectorRef };
  /** For a linear one, millimetres between copies; for a circular one, degrees. */
  spacing: number;
  degrees: number;
  /** How many in all, the instances first. */
  count: number;
  suppressed: boolean;
}

/** Copies of instances at every face of another part like the one the connector's on, such as a screw in every hole. */
export interface ReplicateData { id: string; name: string; of: string[]; target: string; connector: ConnectorRef; suppressed: boolean }

/** An exploded view: steps that move instances by a shift, one after another, only for showing. */
export interface ExplodeData { id: string; name: string; steps: { instances: string[]; shift: [number, number, number] }[] }

/** A named position: where each instance was, to take them all back there, as far as the mates let them go. */
export interface PositionData { id: string; name: string; poses: Record<string, Pose> }

export interface AssemblyData {
  format: 'schmishape-assembly';
  version: 1;
  instances: InstanceData[];
  mates: MateData[];
  next: number;
  patterns?: PatternData[];
  replicates?: ReplicateData[];
  explodes?: ExplodeData[];
  positions?: PositionData[];
}

export const emptyAssembly = (): AssemblyData => ({ format: 'schmishape-assembly', version: 1, instances: [], mates: [], next: 1 });

export function parseAssembly(text: string | null): AssemblyData {
  if (!text) return emptyAssembly();
  try {
    const v = JSON.parse(text);
    if (v?.format === 'schmishape-assembly' && Array.isArray(v.instances) && Array.isArray(v.mates)) return v;
  } catch {
    /* It can't be read, so it's as if there were none. */
  }
  return emptyAssembly();
}

export const MATE_TYPES: MateType[] = ['fastened', 'revolute', 'slider', 'planar', 'cylindrical', 'pin-slot', 'ball', 'parallel', 'tangent', 'width'];
