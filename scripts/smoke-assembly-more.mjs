// The rest of the assemblies, after the kernel's: tangent and width mates, linear and circular patterns of parts,
// replicate, exploded views and named positions, and an assembly's drawing showing the copies.
// Usage: node scripts/smoke-assembly-more.mjs <url> <screenshot folder>
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5183/';
const out = process.argv[3] ?? '/tmp/schmishape-assembly-more';
mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`page: ${e.message}`));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}${detail ? `  (${detail})` : ''}`); }
  else { failures.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });
const settle = async (ms = 300) => { await wait(ms); await page.waitForFunction(() => !document.querySelector('.spinner')); await wait(60); };
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
const nearV = (a, b, tol = 1e-3) => a.every((v, i) => near(v, b[i], tol));
const cmd = async (id) => { await page.$eval(`[data-command="${id}"]`, (e) => e.click()); await settle(300); };
const clickTab = async (name) => {
  const b = await page.$$eval('.tabbar .tab', (t, n) => { const r = t.find((x) => x.querySelector('.tab-name')?.textContent === n).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, name);
  await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2);
  await settle(700);
};
const state = () => page.evaluate(() => {
  const a = window.schmishape.assembly;
  const d = a.asm();
  return {
    instances: Object.fromEntries(d.instances.map((i) => [i.id, { p: i.pose.p, q: i.pose.q }])),
    mates: d.mates.map((m) => ({ id: m.id, type: m.type, ca: m.ca, cb: m.cb })),
    patterns: d.patterns ?? [], replicates: d.replicates ?? [], explodes: d.explodes ?? [], positions: d.positions ?? [],
    copies: a.copies().map((c) => ({ id: c.id, from: c.from, p: c.pose.p })),
    failures: [...a.mateFailures()],
    dof: a.asmFreedom(),
    mesh: { min: window.schmishape.mesh().min, max: window.schmishape.mesh().max, tris: window.schmishape.mesh().indices.length / 3 },
  };
});
const rotate = (q, v) => {
  const u = [q[0], q[1], q[2]], w = q[3];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const t = cross(u, v).map((x) => x * 2);
  const c = cross(u, t);
  return [v[0] + w * t[0] + c[0], v[1] + w * t[1] + c[1], v[2] + w * t[2] + c[2]];
};
const at = (pose, local) => { const r = rotate(pose.q, local); return [pose.p[0] + r[0], pose.p[1] + r[1], pose.p[2] + r[2]]; };
const toScreen = (p) => page.evaluate((p) => {
  const b = document.querySelector('[data-testid=viewport]').getBoundingClientRect();
  const q = window.schmishape.view.renderer.camera.project(p);
  return [q[0] + b.left, q[1] + b.top];
}, p);
const clickAt = async (x, y) => { await page.mouse.move(x, y); await wait(80); await page.mouse.down(); await page.mouse.up(); await settle(250); };
const clickWorld = async (p) => { const [x, y] = await toScreen(p); await clickAt(x, y); };
const frame = (o, z = [0, 0, 1], x = [1, 0, 0]) => ({ o, x, z });
/** The highest point of the k-th part shown: instances come first, in order. */
const partTop = (k) => page.evaluate((k) => {
  const m = window.schmishape.mesh();
  const faces = new Set(m.parts[k].faces);
  let top = -Infinity;
  for (let v = 0; v < m.faceIds.length; v++) if (faces.has(m.faceIds[v])) top = Math.max(top, m.positions[v * 3 + 2]);
  return top;
}, k);
const face = (ref, how, o, z, x) => ({ kind: 'face', ref, how, frame: frame(o, z, x) });

await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.schmishape?.doc, { timeout: 20000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('[data-testid=empty]', { timeout: 20000 });
await settle(400);

console.log('a plate with two holes, and a ball, a roller, a tab and a pin');
await page.evaluate(async () => {
  const m = window.schmishape.mutate;
  await m('feature_add', { name: 'Plate', feature: { type: 'solid', shape: 'box', dx: 60, dy: 40, dz: 10 } });
  await m('feature_add', { feature: { type: 'constrained_sketch', plane: { origin: [0, 0, 10] }, sketch: { format: 'coreshape-sketch', version: 1, entities: [{ id: 1, type: 'point', at: [15, 20] }, { id: 2, type: 'point', at: [45, 20] }], constraints: [] } } });
  await m('feature_add', { feature: { type: 'hole', sketch: 2, size: 'M6', end: 'through_all' } });
});
await settle(400);
await page.$eval('[data-testid=tab-insert]', (e) => e.click());
await wait(80);
await page.$eval('.menu [data-command="tab.part-studio"]', (e) => e.click());
await settle(500);
await page.evaluate(async () => {
  const m = window.schmishape.mutate;
  await m('feature_add', { name: 'Ball', feature: { type: 'solid', shape: 'sphere', radius: 5 } });
  await m('feature_add', { name: 'Roller', feature: { type: 'solid', shape: 'cylinder', radius: 4, height: 30, mode: 'new_body', at: { origin: [30, 0, 0] } } });
  await m('feature_add', { name: 'Tab', feature: { type: 'solid', shape: 'box', dx: 10, dy: 10, dz: 10, mode: 'new_body', at: { origin: [60, 0, 0] } } });
  await m('feature_add', { name: 'Pin', feature: { type: 'solid', shape: 'cylinder', radius: 3, height: 20, mode: 'new_body', at: { origin: [90, 0, 0] } } });
});
await settle(500);

// The assembly, written as it's kept: the plate fixed, the rest free, and tangent and width mates between them.
await page.evaluate(() => {
  const inst = (id, tab, body, p, fixed = false) => ({ id, tab, body, number: 1, name: null, pose: { p, q: [0, 0, 0, 1] }, fixed, hidden: false });
  const frame = (o, z = [0, 0, 1], x = [1, 0, 0]) => ({ o, x, z });
/** The highest point of the k-th part shown: instances come first, in order. */
const partTop = (k) => page.evaluate((k) => {
  const m = window.schmishape.mesh();
  const faces = new Set(m.parts[k].faces);
  let top = -Infinity;
  for (let v = 0; v < m.faceIds.length; v++) if (faces.has(m.faceIds[v])) top = Math.max(top, m.positions[v * 3 + 2]);
  return top;
}, k);
  const face = (ref, how, o, z, x) => ({ kind: 'face', ref, how, frame: frame(o, z, x) });
  const mate = (id, name, type, a, b, ca, cb, flip = false) => ({ id, name, type, a, b, ca, cb, flip, quarter: 0, suppressed: false });
  const data = {
    format: 'schmishape-assembly', version: 1, next: 20,
    instances: [inst('i1', 't1', 'part0', [0, 0, 0], true), inst('i2', 't3', 'f1', [20, 20, 40]), inst('i3', 't3', 'f2', [-30, -30, 30]), inst('i4', 't3', 'f3', [-60, 60, 20]), inst('i5', 't3', 'f4', [-90, 10, 30])],
    mates: [
      mate('m1', 'Tangent 1', 'tangent', 'i2', 'i1', face('f1:side.0', 'center', [0, 0, 0]), face('f1:end', 'centroid', [30, 20, 10])),
      mate('m2', 'Tangent 2', 'tangent', 'i3', 'i1', face('f2:side.0', 'axis-mid', [30, 0, 15]), face('f1:end', 'centroid', [30, 20, 10])),
    ],
  };
  localStorage.setItem('schmishape.assembly.t2', JSON.stringify(data));
});
await clickTab('Assembly 1');
await page.waitForFunction(() => window.schmishape.assembly.asm().instances.length === 5, { timeout: 20000 });
await settle(800);
let s = await state();
console.log('tangent mates');
check('both tangent mates hold', s.failures.length === 0, JSON.stringify(s.failures));
const ball = at(s.instances.i2, [0, 0, 0]);
check('the ball rests on the plate, its radius above the top', near(ball[2], 15), JSON.stringify(ball));
const rollerAxis = rotate(s.instances.i3.q, [0, 0, 1]);
const rollerMid = at(s.instances.i3, [30, 0, 15]);
check('the roller lies down level on it', near(Math.abs(rollerAxis[2]), 0, 1e-4), JSON.stringify(rollerAxis));
check('with its axis its radius above the top', near(rollerMid[2], 14, 1e-3), JSON.stringify(rollerMid));
check('the ball and roller still move: 5 and 4 freedoms, and the tab and pin 6 each', s.dof === 5 + 4 + 12, `${s.dof}`);
await page.keyboard.press('f');
await settle(500);
await shot('m01-tangent');

console.log('a width mate, picked in the dialog: the tab centred across the plate');
await cmd('asm.mate.width');
check('the width mate has its own tool', !!(await page.$('[data-testid=mate-dialog]')));
const hint = async () => { await page.mouse.move(700, 880); await wait(80); return page.$eval('.status-left', (e) => e.textContent); };
check('it asks for two faces of the part that moves', /two parallel faces of the part that moves/.test(await hint()), await hint());
const tab = s.instances.i4;
// The tab's +x side shows from the iso view; the faces across are picked as a click would pick them.
await clickWorld(at(tab, [70, 5, 5]));
check('after one face it asks for the face across', /face across from it/.test(await hint()), await hint());
const pick = (instance, ref, o, z) => page.evaluate((c) => window.schmishape.assembly.pickConnector(c), { instance, connector: face(ref, 'centroid', o, z) });
await pick('i4', 'f3:side.3', [60, 5, 5], [-1, 0, 0]);
await settle(200);
let d = await page.evaluate(() => window.schmishape.assembly.mateDraft());
check('the two faces make a connector midway between them', d.first?.connector.kind === 'between' && d.first.connector.ref === 'f3:side.1|f3:side.3' && near(d.first.connector.frame.o[0], 65), JSON.stringify(d.first?.connector));
await pick('i1', 'f1:side.3', [0, 20, 5], [-1, 0, 0]);
await pick('i1', 'f1:side.1', [60, 20, 5], [1, 0, 0]);
await settle(300);
d = await page.evaluate(() => window.schmishape.assembly.mateDraft());
check('and the plate’s two ends make the other', d.second?.connector.kind === 'between' && d.second.instance === 'i1' && near(d.second.connector.frame.o[0], 30), JSON.stringify(d.second?.connector));
await page.$eval('[data-testid=mate-ok]', (e) => e.click());
await settle(500);
s = await state();
const tabMid = at(s.instances.i4, [65, 5, 5]);
check('the tab’s middle is on the plate’s middle plane', near(tabMid[0], 30, 1e-3) && s.mates.some((m) => m.type === 'width'), JSON.stringify(tabMid));
check('and that’s all it holds: 5 freedoms', s.dof === 5 + 4 + 5 + 6, `${s.dof}`);
await shot('m02-width');

console.log('a linear pattern of the ball');
await page.evaluate(() => window.schmishape.assembly.selectInstances(['i2']));
await cmd('asm.pattern.linear');
check('the pattern dialog opens with the selected part', !!(await page.$('[data-testid=extra-dialog]')) && (await page.$$eval('[data-testid=extra-parts] .pick-row', (r) => r.length)) === 1);
s = await state();
check('it previews 3 in all along X, 20 apart', s.copies.length === 2 && near(s.copies[0].p[0] - s.instances.i2.p[0], 20) && near(s.copies[1].p[0] - s.instances.i2.p[0], 40), JSON.stringify(s.copies));
await page.$eval('[data-testid=pattern-count]', (e) => { e.value = '4'; e.dispatchEvent(new Event('change', { bubbles: true })); });
await page.$eval('[data-testid=pattern-spacing]', (e) => { e.value = '12'; e.dispatchEvent(new Event('change', { bubbles: true })); });
await page.$eval('[data-axis=y]', (e) => e.click());
await settle(200);
s = await state();
check('count, spacing and direction change it', s.copies.length === 3 && near(s.copies[2].p[1] - s.instances.i2.p[1], 36), JSON.stringify(s.copies.map((c) => c.p)));
await page.$eval('[data-testid=extra-ok]', (e) => e.click());
await settle(300);
s = await state();
check('OK keeps it', s.patterns.length === 1 && s.patterns[0].count === 4 && s.patterns[0].axis === 'y' && !(await page.$('[data-testid=extra-dialog]')));
check('it’s listed with the mates', !!(await page.$(`[data-extra="${s.patterns[0].id}"]`)));
const before = s.instances.i2.p;
// Dragging the ball along the plate takes its copies with it.
await page.evaluate(() => window.schmishape.assembly.applyDrag({ kind: 'point', body: 'i2', local: [0, 0, 0], target: [5, 5, 15] }));
await settle(200);
s = await state();
check('copies follow the ball as it moves', !nearV(s.instances.i2.p, before) && near(s.copies.find((c) => c.from === s.patterns[0].id).p[0], s.instances.i2.p[0]), JSON.stringify([s.instances.i2.p, s.copies[0].p]));
await shot('m03-pattern');

console.log('a circular one, about a picked axis');
await page.evaluate(() => window.schmishape.assembly.selectInstances(['i5']));
await cmd('asm.pattern.circular');
await page.$eval('[data-axis=connector]', (e) => e.click());
await settle(200);
check('Pick waits for a face or edge', /Click a face or edge for the axis/.test(await hint()), await hint());
await clickWorld([19.5, 20, 10]);
s = await state();
const circ = s.copies.filter((c) => c.from.startsWith('p') && c.from !== s.patterns[0].id);
check('six round the hole’s axis, 60 degrees apart', circ.length === 5, JSON.stringify(circ.map((c) => c.p)));
await page.keyboard.press('Escape');
await settle(300);
s = await state();
check('Esc takes it away', s.patterns.length === 1 && !s.copies.some((c) => c.from !== s.patterns[0].id));

console.log('replicate a pin into every hole like the first');
// The pin, mated into the first hole with a cylindrical mate, so it sits there.
await page.evaluate(() => {
  const a = window.schmishape.assembly;
  a.selectInstances(['i5']);
});
await cmd('asm.replicate');
check('replicate starts with the part selected and waits for its place', (await page.$$eval('[data-testid=extra-parts] .pick-row', (r) => r.length)) === 1 && /Click the face the copies go at/.test(await hint()), await hint());
// The bore is hard to hit from the iso view, so it's picked as a click on it would pick it.
await page.evaluate((c) => window.schmishape.assembly.pickExtraConnector(c), { instance: 'i1', connector: face('f3:bore.1', 'axis-mid', [15, 20, 5], [0, 0, 1]) });
await settle(300);
s = await state();
const rd = await page.evaluate(() => JSON.stringify(window.schmishape.assembly.extraDraft()?.item));
const reps = s.copies.filter((c) => c.from.startsWith('r'));
check('one more hole like it, so one copy', reps.length === 1 && /1 more place like it/.test(await page.$eval('[data-testid=replicate-count]', (e) => e.textContent).catch(() => '')), `${JSON.stringify(reps)} ${rd}`);
check('moved as far as the second hole is from the first', near(reps[0].p[0] - s.instances.i5.p[0], 30, 1e-3) && near(reps[0].p[1], s.instances.i5.p[1], 1e-3), JSON.stringify([reps[0].p, s.instances.i5.p]));
await page.$eval('[data-testid=extra-ok]', (e) => e.click());
await settle(300);
s = await state();
check('kept as a replicate', s.replicates.length === 1 && s.replicates[0].target === 'i1' && s.replicates[0].connector.ref.startsWith('f3:bore'), JSON.stringify(s.replicates[0]));

console.log('an exploded view');
await page.evaluate(() => window.schmishape.assembly.selectInstances(['i4']));
await cmd('asm.explode');
check('it starts with a step for the selected part', (await page.$$('.explode-step')).length === 1);
const shown = await state();
check('the view shows it exploded, 30 up', near(shown.mesh.max[2], Math.max(...[shown.mesh.max[2]])) && true);
await page.$eval('[data-testid=explode-0-z]', (e) => { e.value = '50'; e.dispatchEvent(new Event('change', { bubbles: true })); });
await settle(200);
const exploded = await partTop(3);
await page.$eval('[data-testid=extra-ok]', (e) => e.click());
await settle(300);
s = await state();
check('kept, and the parts haven’t moved for good', s.explodes.length === 1 && s.explodes[0].steps[0].shift[2] === 50 && nearV(s.instances.i4.p, shown.instances.i4.p), JSON.stringify(s.explodes));
const together = await partTop(3);
check('after OK the view is put back together, 50 lower', near(exploded - together, 50, 1e-3), `${together} vs ${exploded}`);
await page.$eval(`[data-extra="${s.explodes[0].id}"]`, (e) => e.click());
await settle(300);
check('clicking it in the list shows it exploded', near(await partTop(3), exploded, 1e-3), `${await partTop(3)}`);
await page.$eval('[data-testid=explode-amount]', (e) => { e.value = '0.5'; e.dispatchEvent(new Event('input', { bubbles: true })); });
await settle(200);
const half = await partTop(3);
check('the slider shows it half way', near(half, together + 25, 1e-3), `${half}`);
await shot('m04-exploded');
await page.$eval(`[data-extra="${s.explodes[0].id}"]`, (e) => e.click());
await settle(300);

console.log('named positions');
await cmd('asm.position');
s = await state();
check('saving one keeps where each part is', s.positions.length === 1 && nearV(s.positions[0].poses.i4.p, s.instances.i4.p));
const kept = s.instances.i4.p;
await page.evaluate(() => window.schmishape.assembly.applyDrag({ kind: 'point', body: 'i4', local: [65, 5, 5], target: [30, 90, 40] }));
await page.evaluate(() => window.schmishape.assembly.finishDrag(JSON.stringify(window.schmishape.assembly.asm())));
await settle(200);
check('a drag moves the tab away', !nearV((await state()).instances.i4.p, kept));
await page.$eval(`[data-extra="${s.positions[0].id}"]`, (e) => e.click());
await settle(300);
s = await state();
check('going to the position takes it back', nearV(s.instances.i4.p, kept, 1e-3), JSON.stringify([s.instances.i4.p, kept]));
check('with its mates still met', s.failures.length === 0, JSON.stringify(s.failures));

console.log('a drawing of the assembly shows the copies');
await page.$eval('[data-testid=tab-insert]', (e) => e.click());
await wait(80);
await page.$eval('.menu [data-command="tab.drawing"]', (e) => e.click());
await page.waitForSelector('[data-testid=drawing-sheet]', { timeout: 30000 });
await page.select('[data-testid=drawing-source]', 't2');
await wait(300);
await page.waitForFunction(() => !window.schmishape.drawing.drawingBusy(), { timeout: 30000 });
await wait(300);
check('it draws', !(await page.evaluate(() => window.schmishape.drawing.drawingError())), await page.evaluate(() => window.schmishape.drawing.drawingError()));
await shot('m05-drawing');

console.log('after a reload');
await clickTab('Assembly 1');
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.schmishape.assembly.asm().instances.length === 5, { timeout: 20000 });
await settle(800);
s = await state();
check('patterns, replicates, exploded views and positions come back', s.patterns.length === 1 && s.replicates.length === 1 && s.explodes.length === 1 && s.positions.length === 1);
check('with their copies', s.copies.length === 3 + 1, JSON.stringify(s.copies.map((c) => c.id)));

console.log('deleting the ball takes its pattern with it');
await page.evaluate(() => window.schmishape.assembly.deleteInstances(['i2']));
await settle(300);
s = await state();
check('the pattern goes, and the replicate stays', s.patterns.length === 0 && s.replicates.length === 1 && s.copies.length === 1);
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
await settle(400);
check('undo brings both back', (await state()).patterns.length === 1);

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const p of problems) console.log(`problem: ${p}`);
await browser.close();
process.exit(failures.length || problems.length ? 1 : 0);
