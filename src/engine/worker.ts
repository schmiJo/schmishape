// Runs the kernel off the main thread, so a slow rebuild can't freeze the page. A kernel panic traps
// the instance, so this reports it and starts a fresh one. The caller restores the document.
import wasmUrl from './engine.wasm?url';

interface Exports {
  memory: WebAssembly.Memory;
  sx_init(): void;
  sx_alloc(n: number): number;
  sx_out_len(): number;
  sx_call(p: number, n: number): number;
  sx_tools(): number;
  sx_env(): number;
  sx_mesh(upto: number, draft: number): number;
  sx_stl(): number;
  sx_drawing(p: number, n: number): number;
}

const dec = new TextDecoder();
const enc = new TextEncoder();
let compiled: WebAssembly.Module;
let x: Exports;
let panic = '';

function start() {
  panic = '';
  const instance = new WebAssembly.Instance(compiled, {
    env: {
      sx_on_panic(p: number, n: number) {
        panic = text(p, n);
      },
      // Sent while the call is still running: the page is free to show it, the worker isn't.
      sx_progress(p: number, n: number) {
        self.postMessage({ progress: text(p, n) });
      },
    },
  });
  x = instance.exports as unknown as Exports;
  x.sx_init();
}

// Wasm hands back addresses as signed 32-bit numbers, so past 2 GB of memory, as a large STEP import takes, they
// come out negative. `>>> 0` reads them as the unsigned addresses they are.
const at = (p: number) => p >>> 0;
const text = (p: number, n: number) => dec.decode(new Uint8Array(x.memory.buffer, at(p), at(n)));

function call(message: string, fn: (p: number, n: number) => number = x.sx_call): string {
  const bytes = enc.encode(message);
  const p = at(x.sx_alloc(bytes.length));
  new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes);
  const r = fn(p, bytes.length);
  return text(r, x.sx_out_len());
}

function mesh(upto: number, draft: boolean) {
  // Call first: meshing can grow memory, which detaches any view or buffer taken before it.
  const table = at(x.sx_mesh(upto, draft ? 1 : 0));
  const buf = x.memory.buffer;
  const t = new Uint32Array(buf, table, 14).slice();
  const out = {
    positions: new Float32Array(buf, t[0], t[1]).slice(),
    normals: new Float32Array(buf, t[2], t[3]).slice(),
    faceIds: new Uint32Array(buf, t[4], t[5]).slice(),
    indices: new Uint32Array(buf, t[6], t[7]).slice(),
    segments: new Float32Array(buf, t[8], t[9]).slice(),
    segmentIds: new Uint32Array(buf, t[10], t[11]).slice(),
    info: text(t[12], t[13]),
  };
  return { out, transfer: [out.positions.buffer, out.normals.buffer, out.faceIds.buffer, out.indices.buffer, out.segments.buffer, out.segmentIds.buffer] };
}

self.onmessage = (e: MessageEvent) => {
  const { id, op, message, upto, draft } = e.data;
  try {
    switch (op) {
      case 'call':
        self.postMessage({ id, ok: true, result: call(message) });
        break;
      case 'mesh': {
        const m = mesh(upto, draft);
        (self as unknown as Worker).postMessage({ id, ok: true, result: m.out }, m.transfer as Transferable[]);
        break;
      }
      case 'drawing':
        self.postMessage({ id, ok: true, result: call(message, x.sx_drawing) });
        break;
      case 'env':
        self.postMessage({ id, ok: true, result: text(x.sx_env(), x.sx_out_len()) });
        break;
      case 'tools':
        self.postMessage({ id, ok: true, result: text(x.sx_tools(), x.sx_out_len()) });
        break;
      case 'stl': {
        const p = at(x.sx_stl());
        const bytes = new Uint8Array(x.memory.buffer, p, at(x.sx_out_len())).slice();
        (self as unknown as Worker).postMessage({ id, ok: true, result: bytes }, [bytes.buffer] as Transferable[]);
        break;
      }
    }
  } catch (err) {
    self.postMessage({ id, ok: false, crash: panic || String(err) });
    start();
  }
};

(async () => {
  const response = await fetch(wasmUrl);
  compiled = await WebAssembly.compile(await response.arrayBuffer());
  start();
  self.postMessage({ ready: true });
})().catch((err) => self.postMessage({ failed: String(err) }));
