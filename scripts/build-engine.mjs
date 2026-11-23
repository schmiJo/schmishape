// Builds the Rust engine to WebAssembly and puts it where the worker imports it from.
//
// The kernel comes from ../core_shape as it is checked out, unless engine/kernel-rev names a commit of it: then that
// commit is exported with `git archive` into engine/.kernel/<rev>, which only reads the kernel's repository, and the
// engine is built against that copy. That's for using kernel work that isn't on its master yet. Delete the file to go
// back to the checkout.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, PATH: `${join(homedir(), '.cargo/bin')}:${process.env.PATH}` };
const kernelRepo = resolve(root, '../core_shape');
const revFile = join(root, 'engine/kernel-rev');
const rev = process.env.KERNEL_REV ?? (existsSync(revFile) ? readFileSync(revFile, 'utf8').trim() : '');

let manifest = 'engine/Cargo.toml';
if (rev) {
  const full = spawnSync('git', ['-C', kernelRepo, 'rev-parse', '--verify', `${rev}^{commit}`], { encoding: 'utf8' });
  if (full.status !== 0) {
    console.error(`engine/kernel-rev names ${rev}, which isn't a commit of ${kernelRepo}`);
    process.exit(1);
  }
  const hash = full.stdout.trim();
  const copy = join(root, 'engine/.kernel', hash.slice(0, 12));
  if (!existsSync(join(copy, 'Cargo.toml'))) {
    rmSync(copy, { recursive: true, force: true });
    mkdirSync(copy, { recursive: true });
    const tar = spawnSync('sh', ['-c', `git -C "${kernelRepo}" archive "${hash}" | tar -x -C "${copy}"`], { stdio: 'inherit' });
    if (tar.status !== 0) process.exit(tar.status ?? 1);
  }
  // The same manifest, pointed at the copy, beside it so the engine's own one is left as it is.
  const own = readFileSync(join(root, 'engine/Cargo.toml'), 'utf8');
  const pointed = own
    .replaceAll('../../core_shape/', `${copy}/`)
    .replace('[lib]', `[lib]\npath = "${join(root, 'engine/src/lib.rs')}"`);
  const dir = join(root, 'engine/.kernel/manifest');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Cargo.toml'), pointed);
  if (existsSync(join(root, 'engine/Cargo.lock')) && !existsSync(join(dir, 'Cargo.lock'))) copyFileSync(join(root, 'engine/Cargo.lock'), join(dir, 'Cargo.lock'));
  manifest = join(dir, 'Cargo.toml');
  console.log(`kernel ${rev} (${hash.slice(0, 7)}), not the checkout`);
}

const built = spawnSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', manifest, '--target-dir', join(root, 'engine/target')], { cwd: root, env, stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);
const from = join(root, 'engine/target/wasm32-unknown-unknown/release/schmishape_engine.wasm');
const to = join(root, 'src/engine/engine.wasm');
copyFileSync(from, to);
console.log(`engine.wasm ${(statSync(to).size / 1024).toFixed(0)} KiB`);
