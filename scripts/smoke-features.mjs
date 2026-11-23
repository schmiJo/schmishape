// The kernel's newer features through their dialogs: extrude ends and regions from several sketches, revolve about a
// line, sweep, helix, transform, boolean, surfaces, and older documents' hidden sketch copies being upgraded.
// Usage: node scripts/smoke-features.mjs <url> <screenshot folder>
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5183/';
const out = process.argv[3] ?? '/tmp/schmishape-features';
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
const settle = async (ms = 250) => { await wait(ms); await page.waitForFunction(() => !document.querySelector('.spinner')); await wait(60); };
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const cmd = async (id) => { await page.$eval(`[data-command="${id}"]`, (e) => e.click()); await settle(500); };
const clickAt = async (x, y) => { await page.mouse.move(x, y); await wait(16); await page.mouse.down(); await page.mouse.up(); await wait(40); };
const state = () => page.evaluate(() => {
  const d = window.schmishape.doc;
  return {
    features: JSON.parse(JSON.stringify(d.features)),
    steps: d.steps.map((s) => ({ id: s.id, name: s.name, state: s.state, error: s.error })),
    volume: d.solid?.volume ?? 0,
    valid: d.solid?.valid ?? null,
    failed: d.failed,
    parts: (window.schmishape.mesh()?.parts ?? []).map((p) => ({ name: p.name, sheet: p.sheet })),
  };
});
const last = (s) => s.features[s.features.length - 1];
const ok = () => page.$eval('[data-testid=dialog-ok]', (e) => e.click());
const accept = async () => { await ok(); await settle(500); };
const dialogOpen = () => page.$('[data-testid=dialog]').then((e) => !!e);
const okEnabled = () => page.$eval('[data-testid=dialog-ok]', (e) => !e.disabled);
const dialogError = () => page.$eval('[data-testid=dialog-error]', (e) => e.textContent).catch(() => null);
const mutate = (tool, args) => page.evaluate((t, a) => window.schmishape.mutate(t, a).then((r) => r.text), tool, args);
const select = async (field, value) => { await page.select(`[data-field=${field}]`, value); await settle(450); };
const clickTab = async (name) => { await page.$$eval('.dialog-tabs button', (b, n) => b.find((x) => x.textContent === n).click(), name); await settle(400); };
const clickSegment = async (label, name) => { await page.$$eval(`[aria-label="${label}"] button`, (b, n) => b.find((x) => x.textContent === n).click(), name); await settle(400); };
const typeInto = async (field, text) => { await page.$eval(`[data-field=${field}]`, (e) => { e.focus(); e.select(); }); await page.keyboard.type(text); await settle(400); };
const toScreen = (x, y, z = 0) => page.evaluate((p) => {
  const b = document.querySelector('[data-testid=viewport]').getBoundingClientRect();
  const q = window.schmishape.view.renderer.camera.project(p);
  return [q[0] + b.left, q[1] + b.top];
}, [x, y, z]);
const clickWorld = async (x, y, z = 0) => { const [a, b] = await toScreen(x, y, z); await clickAt(a, b); await settle(200); };
const activeBox = () => page.$eval('[aria-current=true][data-pick]', (e) => e.dataset.pick).catch(() => null);
const rows = (key) => page.$$eval(`[data-pick=${key}] .pick-row .pick-name`, (n) => n.map((x) => x.textContent));
const fit = async () => { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('f'); await settle(400); };

const sketch = (entities, origin = [0, 0, 0]) => ({ type: 'constrained_sketch', plane: { origin }, sketch: { format: 'coreshape-sketch', version: 1, entities, constraints: [] } });
const rect = (id, x, y, w, h) => [
  { id, type: 'line', start: [x, y], end: [x + w, y] }, { id: id + 1, type: 'line', start: [x + w, y], end: [x + w, y + h] },
  { id: id + 2, type: 'line', start: [x + w, y + h], end: [x, y + h] }, { id: id + 3, type: 'line', start: [x, y + h], end: [x, y] },
];
const circle = (id, cx, cy, r) => ({ id, type: 'circle', center: [cx, cy], radius: r });
const fresh = async () => { await mutate('document_new', {}); await settle(300); };

await page.goto(url, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.clear());
await page.goto(url, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.schmishape?.engine);
await settle(800);

console.log('Older documents with hidden sketch copies');
{
  const ents = [...rect(1, 0, 0, 40, 30), circle(5, 70, 15, 8)];
  const base = sketch(ents);
  const arr = await page.evaluate((s) => window.schmishape.engine.call('sketch_arrangement', { sketch: s }).then((r) => JSON.parse(r.text)), base.sketch);
  const circleId = arr.regions.find((r) => Math.abs(r.area - Math.PI * 64) < 1).id;
  const legacy = {
    format: 'coreshape-document', version: 1, units: 'mm', next_id: 7, parameters: [],
    features: [
      { id: 1, name: 'Sketch 1', ...base },
      { id: 2, name: '~regions:1 1', type: 'constrained_sketch', plane: base.plane, sketch: { ...base.sketch, picked_regions: [circleId] } },
      { id: 3, name: 'Extrude 1', type: 'extrude', sketch: 2, length: 10, mode: 'new_body' },
      { id: 4, name: '~axis:1', type: 'constrained_sketch', plane: { origin: [0, 0, 0], z: [0, 1, 0], x: [1, 0, 0] }, sketch: base.sketch },
      { id: 5, name: 'Revolve 1', type: 'revolve', sketch: 4, degrees: 90, mode: 'new_body' },
      { id: 6, name: 'Fillet 1', type: 'fillet', edges: { between: ['f3:end', 'f3:side.5'] }, radius: 1 },
    ],
  };
  const text = JSON.stringify(legacy);
  const before = await page.evaluate((t) => window.schmishape.engine.call('document_open', { text: t }).then((r) => JSON.parse(r.text.slice(r.text.indexOf('{')))), text);
  check('the old document builds as it is', before.features.every((f) => f.state !== 'failed' && f.state !== 'blocked'), JSON.stringify(before.features.map((f) => f.state)));
  await mutate('document_open', { text });
  await settle(400);
  const s = await state();
  check('opening it leaves no hidden copies', !s.features.some((f) => f.name.startsWith('~')), s.features.map((f) => f.name).join(', '));
  const ex = s.features.find((f) => f.name === 'Extrude 1');
  check('the extrude takes its region from the sketch itself', ex?.sketch === 1 && JSON.stringify(ex.regions) === JSON.stringify([circleId]), JSON.stringify(ex));
  const rv = s.features.find((f) => f.name === 'Revolve 1');
  check('the revolve turns about the sketch’s vertical axis', rv?.sketch === 1 && JSON.stringify(rv.axis) === JSON.stringify({ point: [0, 0], direction: [0, 1] }), JSON.stringify(rv));
  check('the shape is the same', near(s.volume, before.solid.volume, 1e-6), `${s.volume} vs ${before.solid.volume}`);
  check('and the fillet still finds its edge', s.steps.every((x) => x.state !== 'failed' && x.state !== 'blocked'), JSON.stringify(s.steps));
}

const edit = async (id) => { await page.$eval(`[data-feature="${id}"]`, (e) => e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); await settle(700); };
const regionId = (s, sketchId, area) => page.evaluate((id, a) => window.schmishape.sketchRegions().get(id).find((r) => Math.abs(r.area - a) < 1).id, sketchId, area);

console.log('Extrude: regions of two sketches, and where it ends');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 100, dy: 60, dz: 10, at: { origin: [0, 0, 30] }, mode: 'new_body' }, name: 'Ceiling' });
  await mutate('feature_add', { feature: sketch([...rect(1, 0, 0, 40, 30), circle(5, 70, 15, 8)]), name: 'Sketch 1' });
  await mutate('feature_add', { feature: sketch([circle(1, 20, 45, 5)]), name: 'Sketch 2' });
  await settle(300);
  await fit();
  await cmd('extrude');
  check('the dialog opens with the regions box taking clicks', (await activeBox()) === 'regions', `${await activeBox()}`);
  check('Solid and Surface are the top tabs', JSON.stringify(await page.$$eval('.dialog-tabs button', (b) => b.map((x) => x.textContent))) === '["Solid","Surface"]');
  const crowded = await page.$$eval('[aria-label=Result] button', (b) => b.filter((x) => x.scrollWidth > x.clientWidth + 1).map((x) => x.textContent));
  check('every Result button has room for its word', crowded.length === 0, JSON.stringify(crowded));
  // New, so that each one's volume counts on its own and the ends can be told apart.
  await clickSegment('Result', 'New');
  await clickWorld(70, 15, 0);
  await clickWorld(20, 45, 0);
  let r = await rows('regions');
  check('a region of each sketch is picked', r.length === 2 && r[0] === 'Region of Sketch 1' && r[1] === 'All of Sketch 2', JSON.stringify(r));
  await select('end', 'up_to_face');
  check('choosing Up to face hands the clicks to its box', (await activeBox()) === 'endFace', `${await activeBox()}`);
  check('and it can’t be added until a face is picked', !(await okEnabled()));
  await shot('extrude-up-to-face-waiting');
  await clickWorld(50, 30, 40);
  r = await rows('endFace');
  check('a click on the top of the box picks it', r.length === 1 && r[0] === 'Flat face', JSON.stringify(r));
  await shot('extrude-up-to-face');
  await accept();
  let s = await state();
  const ex = last(s);
  const a = await regionId(s, 2, Math.PI * 64), b = await regionId(s, 3, Math.PI * 25);
  check('the extrude lists both sketches’ regions', ex.sketch === 2 && JSON.stringify(ex.regions) === JSON.stringify([a, { sketch: 3, region: b }]), JSON.stringify(ex.regions));
  check('and ends at the face', JSON.stringify(ex.end) === JSON.stringify({ type: 'up_to_face', face: 'f1:end' }), JSON.stringify(ex.end));
  const box = 100 * 60 * 10;
  const want = box + Math.PI * (64 + 25) * 40;
  check('both reach the top of the box', near(s.volume, want, 2e-3) && !s.failed, `${s.volume} vs ${want}`);
  check('no hidden sketches were made', !s.features.some((f) => f.name.startsWith('~')));

  await edit(ex.id);
  check('editing reads it back', JSON.stringify(await rows('regions')) === JSON.stringify(['Region of Sketch 1', 'All of Sketch 2']) && (await page.$eval('[data-field=end]', (e) => e.value)) === 'up_to_face', JSON.stringify(await rows('regions')));
  await select('end', 'through_all');
  check('Through all needs nothing more', await okEnabled());
  s = await state();
  check('and goes through the box', near(s.volume, 100 * 60 * 10 + Math.PI * (64 + 25) * 40, 2e-3), `${s.volume}`);
  await select('end', 'up_to_part');
  check('Up to part takes the clicks', (await activeBox()) === 'endPart');
  await clickWorld(50, 30, 40);
  r = await rows('endPart');
  check('a click on the box picks the part', JSON.stringify(r) === '["Part 1"]', JSON.stringify(r));
  s = await state();
  check('which stops at its near side', near(s.volume, 100 * 60 * 10 + Math.PI * (64 + 25) * 30, 2e-3) && JSON.stringify(last(s).end) === JSON.stringify({ type: 'up_to_part', part: 'f1' }), `${s.volume} ${JSON.stringify(last(s).end)}`);
  await select('end', 'up_to_vertex');
  await clickWorld(97, 60, 40);
  r = await rows('endVertex');
  s = await state();
  check('Up to vertex picks the corner nearest the click', r.length === 1 && JSON.stringify(last(s).end?.vertex?.near) === '[100,60,40]', `${JSON.stringify(r)} ${JSON.stringify(last(s).end)}`);
  check('and stops level with it', near(s.volume, 100 * 60 * 10 + Math.PI * (64 + 25) * 40, 2e-3), `${s.volume}`);
  await select('end', 'blind');
  await page.$eval('[data-pick=regions]', (e) => e.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await settle(200);
  check('clicking the regions box gives it the clicks back', (await activeBox()) === 'regions');
  await clickWorld(20, 45, 0);
  r = await rows('regions');
  check('so a click drops Sketch 2', JSON.stringify(r) === '["Region of Sketch 1"]', JSON.stringify(r));
  await accept();
  s = await state();
  check('a blind extrude of one region has no end written', last(s).end === undefined && JSON.stringify(last(s).regions) === JSON.stringify([a]), JSON.stringify(last(s)));
}

console.log('Revolve about a line of the sketch');
{
  await fresh();
  const ents = [...rect(1, 10, 0, 20, 30), { id: 9, type: 'line', start: [-5, 0], end: [-5, 30], construction: true }];
  await mutate('feature_add', { feature: sketch(ents), name: 'Profile' });
  await settle(300);
  await fit();
  await cmd('revolve');
  let s = await state();
  check('a revolve starts about the sketch’s vertical axis', near(s.volume, Math.PI * (30 ** 2 - 10 ** 2) * 30, 1e-3), `${s.volume}`);
  await shot('revolve-default');
  await clickWorld(-5, 15, 0);
  s = await state();
  check('clicking the line makes it the axis', last(s).app?.axis === 'line:9' && JSON.stringify(last(s).axis) === JSON.stringify({ point: [-5, 0], direction: [0, 30] }), JSON.stringify(last(s).axis));
  check('which makes a bigger ring', near(s.volume, Math.PI * (35 ** 2 - 15 ** 2) * 30, 1e-3), `${s.volume}`);
  check('the dropdown says which line', (await page.$eval('[data-field=axis]', (e) => e.selectedOptions[0].textContent)).startsWith('Construction line'));
  await shot('revolve-line');
  await accept();
  const moved = [...rect(1, 10, 0, 20, 30), { id: 9, type: 'line', start: [-10, 0], end: [-10, 30], construction: true }];
  await mutate('feature_edit', { id: 1, feature: sketch(moved) });
  await settle(300);
  s = await state();
  check('moving the line takes the axis with it', JSON.stringify(last(s).axis) === JSON.stringify({ point: [-10, 0], direction: [0, 30] }) && near(s.volume, Math.PI * (40 ** 2 - 20 ** 2) * 30, 1e-3), `${JSON.stringify(last(s).axis)} ${s.volume}`);
  await edit(last(s).id);
  check('editing it shows the line', (await page.$eval('[data-field=axis]', (e) => e.value)) === 'line:9');
  await select('axis', 'x_axis');
  s = await state();
  check('the horizontal axis can be chosen instead', JSON.stringify(last(s).axis) === JSON.stringify({ point: [0, 0], direction: [1, 0] }), JSON.stringify(last(s).axis));
  await page.keyboard.press('Escape');
  await settle(400);
}

console.log('Sweep and helix');
{
  await fresh();
  // As in Onshape: a profile, and a path picked in the view, here a sketch's line and arc on Front, from the profile.
  await mutate('feature_add', { feature: sketch([circle(1, 0, 0, 3)]), name: 'Profile' });
  await mutate('feature_add', { feature: { type: 'constrained_sketch', plane: { on_plane: 'front' }, sketch: { format: 'coreshape-sketch', version: 1, entities: [{ id: 1, type: 'line', start: [0, 0], end: [0, 30] }, { id: 2, type: 'arc', center: [20, 30], radius: 20, start: [20, 50], end: [0, 30] }], constraints: [] } }, name: 'Path' });
  await settle(300);
  await page.keyboard.press('0');
  await fit();
  await page.$eval('[data-feature="1"]', (e) => e.click());
  await cmd('sweep');
  check('Sweep takes the selected sketch as its profile, and waits for the path', (await page.$eval('[data-field=sketch]', (e) => e.value)) === '1' && (await activeBox()) === 'pathPick');
  await clickWorld(0, 0, 15);
  let s = await state();
  const length = 30 + 20 * Math.PI / 2;
  check('clicking a curve of the path sketch takes all of it', JSON.stringify(last(s).path) === JSON.stringify({ sketch: 2 }) && JSON.stringify(await rows('pathPick')) === '["Curves of Path"]', `${JSON.stringify(last(s).path)} ${JSON.stringify(await rows('pathPick'))}`);
  check('and sweeps along it', near(s.volume, Math.PI * 9 * length, 5e-3) && s.valid, `${s.volume} vs ${Math.PI * 9 * length}`);
  await accept();

  // An older sweep, made of straight runs and bends, keeps that form when it's edited.
  await fresh();
  await mutate('feature_add', { feature: sketch([circle(1, 0, 0, 3)]), name: 'Profile' });
  await mutate('feature_add', { feature: { type: 'sweep', sketch: 1, path: [{ line: 30 }, { arc_radius: 20, degrees: 90, toward_degrees: 0 }], mode: 'new_body' }, name: 'Sweep 1' });
  await settle(300);
  await edit(2);
  s = await state();
  check('a sweep goes straight on and bends', near(s.volume, Math.PI * 9 * length, 5e-3) && s.valid, `${s.volume} vs ${Math.PI * 9 * length}`);
  await page.$$eval('.step-add button', (b) => b.find((x) => x.textContent === 'Add straight').click());
  await settle(500);
  await page.$eval('[data-step="2.length"]', (e) => { e.focus(); e.select(); });
  await page.keyboard.type('15');
  await settle(500);
  s = await state();
  check('a step added to the path carries it on', JSON.stringify(last(s).path[2]) === JSON.stringify({ line: 15 }) && near(s.volume, Math.PI * 9 * (length + 15), 5e-3), `${JSON.stringify(last(s).path)} ${s.volume}`);
  await shot('sweep');
  const squeezed = await page.$$eval('.step-input input', (i) => i.filter((x) => x.clientWidth < 18).length);
  check('every step’s boxes have room for a number', squeezed === 0, `${squeezed} too narrow`);
  await accept();

  await fresh();
  await mutate('feature_add', { feature: { type: 'constrained_sketch', plane: { origin: [0, 0, 0], z: [0, -1, 0], x: [1, 0, 0] }, sketch: { format: 'coreshape-sketch', version: 1, entities: [circle(1, 10, 0, 1)], constraints: [] } }, name: 'Wire' });
  await settle(300);
  await cmd('helix');
  await typeInto('pitch', '6');
  s = await state();
  const turn = Math.hypot(2 * Math.PI * 10, 6);
  check('a helix winds the sketch round the axis', last(s).type === 'helix' && near(s.volume, Math.PI * 4 * turn, 0.02) && s.valid, `${s.volume} vs ${Math.PI * 4 * turn}`);
  await fit();
  await shot('helix');
  await accept();
  check('the helix is added', !(await dialogOpen()) && last(await state()).type === 'helix');
}

console.log('Surfaces');
{
  await fresh();
  await mutate('feature_add', { feature: sketch(rect(1, 0, 0, 20, 20)), name: 'Bottom' });
  await mutate('feature_add', { feature: sketch(rect(1, 0, 0, 20, 20), [0, 0, 10]), name: 'Top' });
  await settle(300);
  await page.evaluate(() => window.schmishape.startFeature('extrude'));
  await settle(500);
  await fit();
  await clickWorld(10, 10, 0);
  await clickTab('Surface');
  await shot('surface-dialog');
  check('a surface has no Result to choose', !(await page.$('[aria-label=Result]')));
  check('and only Blind as an end', await page.$eval('[data-field=end]', (e) => [...e.options].filter((o) => !o.disabled).map((o) => o.value).join()) === 'blind');
  await typeInto('length', '10');
  await accept();
  let s = await state();
  check('the extrude made a surface', last(s).mode === 'surface' && s.parts.length === 1 && s.parts[0].sheet, JSON.stringify(s.parts));
  check('which the parts list calls Surface 1', (await page.$$eval('.parts .geo-row .feature-name', (n) => n.map((x) => x.textContent))).includes('Surface 1'));
  for (const name of ['Bottom', 'Top']) {
    await cmd('fill');
    const id = s.features.find((f) => f.name === name).id;
    await page.select('.dialog .select', String(id));
    await settle(400);
    await accept();
  }
  s = await state();
  check('two fills add a surface each', s.parts.filter((p) => p.sheet).length === 3, JSON.stringify(s.parts));
  await page.mouse.move(700, 700);
  await fit();
  await shot('surfaces');
  await cmd('sew');
  await accept();
  s = await state();
  check('sewing closes them into a solid', s.parts.length === 1 && !s.parts[0].sheet && near(s.volume, 4000, 1e-3), `${JSON.stringify(s.parts)} ${s.volume}`);
  await shot('sewn');
}

console.log('Transform, boolean and delete part');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 20, dy: 20, dz: 20, mode: 'new_body' }, name: 'Block' });
  await settle(300);
  await fit();
  await cmd('transform');
  await clickWorld(5, 0, 10);
  check('a click picks the part to move', JSON.stringify(await rows('bodies')) === '["Part 1"]', JSON.stringify(await rows('bodies')));
  await typeInto('dx', '10');
  await typeInto('dz', '0');
  await page.$eval('[data-field=copy]', (e) => e.click());
  await settle(500);
  await accept();
  let s = await state();
  check('a copy moved along x is a second part', s.parts.length === 2 && near(s.volume, 16000, 1e-3), `${s.parts.length} ${s.volume}`);
  await cmd('boolean');
  await clickWorld(5, 0, 10);
  await clickWorld(25, 0, 10);
  check('both parts are picked', (await rows('tools')).length === 2, JSON.stringify(await rows('tools')));
  await accept();
  s = await state();
  check('union makes one part of them', s.parts.length === 1 && near(s.volume, 12000, 1e-3), `${s.parts.length} ${s.volume}`);
  await mutate('feature_add', { feature: { type: 'solid', shape: 'sphere', radius: 5, at: { origin: [60, 0, 0] }, mode: 'new_body' }, name: 'Ball' });
  await settle(300);
  await fit();
  await cmd('delete-bodies');
  await clickWorld(60, -4.9, 0);
  await accept();
  s = await state();
  check('Delete part takes the ball away', s.parts.length === 1 && near(s.volume, 12000, 1e-3) && last(s).type === 'delete_bodies', `${s.parts.length} ${s.volume}`);
}

console.log('Variable fillet');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 40, dy: 20, dz: 20 }, name: 'Block' });
  await settle(300);
  await fit();
  await cmd('fillet');
  await clickWorld(20, 0, 20);
  await page.$eval('[data-field=variable]', (e) => e.click());
  await settle(600);
  let s = await state();
  check('Variable radius writes a fillet that changes along the edge', last(s).type === 'fillet_radii' && last(s).sets[0].along.length === 2 && s.valid && !s.failed, `${JSON.stringify(last(s))} ${s.failed}`);
  await accept();
  await edit(last(s).id);
  check('and reads back as one', (await page.$eval('[data-field=variable]', (e) => e.checked)) && (await rows('edges')).length === 1);
  await page.keyboard.press('Escape');
  await settle(300);
}

console.log('Extrude a part’s flat faces');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 40, dy: 30, dz: 10 }, name: 'Block' });
  await mutate('feature_add', { feature: { type: 'solid', shape: 'cylinder', radius: 5, height: 10, at: { origin: [60, 15, 0] }, mode: 'new_body' }, name: 'Peg' });
  await settle(300);
  await fit();
  await cmd('extrude');
  check('Extrude opens with no sketch in the document', await dialogOpen());
  check('its box takes faces and regions', (await page.$eval('[data-pick=regions] .pick-label', (e) => e.textContent)) === 'Faces and sketch regions to extrude');
  await clickWorld(20, 15, 10);
  let r = await rows('regions');
  let s = await state();
  check('a click on the top picks it', JSON.stringify(r) === '["Flat face"]' && JSON.stringify(last(s).faces) === '["f1:end"]' && last(s).sketch === undefined, `${JSON.stringify(r)} ${JSON.stringify(last(s))}`);
  check('and it grows up from there', near(s.volume, 40 * 30 * 30 + Math.PI * 25 * 10, 1e-3), `${s.volume}`);
  await shot('face-extrude');
  await clickWorld(65, 15, 5);
  r = await rows('regions');
  check('a curved face isn’t taken', JSON.stringify(r) === '["Flat face"]', JSON.stringify(r));
  await clickSegment('Result', 'Remove');
  await page.$eval('[data-testid=flip-direction]', (e) => e.click());
  await settle(500);
  await typeInto('length', '4');
  s = await state();
  check('flipped and Remove, it cuts down into the part', near(s.volume, 40 * 30 * 6 + Math.PI * 25 * 10, 1e-3) && !s.failed, `${s.volume} ${s.failed}`);
  await accept();
  s = await state();
  check('it goes in with no sketch', last(s).type === 'extrude' && last(s).sketch === undefined && last(s).mode === 'remove', JSON.stringify(last(s)));
  await edit(last(s).id);
  r = await rows('regions');
  check('editing shows the face', JSON.stringify(r) === '["Flat face"]', JSON.stringify(r));
  await page.keyboard.press('Escape');
  await settle(400);

  await clickWorld(20, 0, 3);
  await settle(200);
  await cmd('extrude');
  r = await rows('regions');
  s = await state();
  check('a face selected first is what Extrude takes', JSON.stringify(r) === '["Flat face"]' && JSON.stringify(last(s).faces) === '["f1:side.0"]', `${JSON.stringify(r)} ${JSON.stringify(last(s).faces)}`);
  await page.keyboard.press('Escape');
  await settle(400);
  {
    const [x, y] = await toScreen(20, 15, 6);
    await page.mouse.click(x, y, { button: 'right' });
    await wait(200);
    const items = await page.$$eval('.menu [data-item]', (m) => m.map((x) => [x.dataset.item, x.disabled ?? false]));
    check('right-clicking a flat face offers Extrude', items.some(([n, off]) => n === 'Extrude' && !off), JSON.stringify(items));
    await page.keyboard.press('Escape');
    await settle(200);
  }
}

console.log('A part’s corners and edges while sketching');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 40, dy: 30, dz: 10 }, name: 'Block' });
  await settle(300);
  await fit();
  await page.evaluate(() => document.querySelector('[data-command="sketch"]').click());
  await settle(300);
  await clickWorld(20, 15, 10);
  await settle(600);
  check('a sketch opens on the top', await page.evaluate(() => !!window.schmishape.session()));
  await page.keyboard.press('v');
  await page.waitForFunction(() => !!window.schmishape.session()?.part, { timeout: 5000 }).catch(() => {});
  const hoverAt = async (x, y, z) => { const [a, b] = await toScreen(x, y, z); await page.mouse.move(a + 1, b + 1); await wait(150); return page.evaluate(() => window.schmishape.session().hover); };
  const corner = await hoverAt(40, 0, 10);
  check('hovering a corner of the block finds it', /^pv\d+$/.test(corner ?? ''), `${corner}`);
  await shot('sketch-part-corner');
  const edge = await hoverAt(20, 0, 10);
  check('hovering an edge of the block finds it', /^pe\d+$/.test(edge ?? ''), `${edge}`);
  check('a corner hidden behind the block can’t be picked', !/^p/.test((await hoverAt(0, 30, 0)) ?? ''), `${await hoverAt(0, 30, 0)}`);
  await page.keyboard.press('l');
  await clickWorld(10, 10, 10);
  await clickWorld(30, 10, 10);
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  await settle(400);
  await clickWorld(30, 10, 10);
  { const [a, b] = await toScreen(40, 0, 10); await page.keyboard.down('Shift'); await clickAt(a + 1, b + 1); await page.keyboard.up('Shift'); }
  await settle(200);
  const sel = await page.evaluate(() => window.schmishape.session().selection[0]());
  check('a line’s end and the corner can be selected together', sel.length === 2 && sel.some((k) => /^pv/.test(k)), JSON.stringify(sel));
  check('which turns Coincident on', await page.$eval('[data-constraint=coincident]', (e) => !e.disabled));
  await shot('sketch-part-selected');
  await page.$eval('[data-constraint=coincident]', (e) => e.click());
  await settle(500);
  let sk = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.session().data)));
  const linkedPoint = sk.entities.find((e) => e.type === 'projected' && e.from?.vertex);
  const lineEnd = sk.entities.find((e) => e.id === 1)?.end;
  check('Coincident brings the corner in as a linked point', !!linkedPoint && sk.constraints.some((c) => c.type === 'coincident' && c.b === String(linkedPoint.id)), JSON.stringify(sk.entities.map((e) => e.type)));
  check('and the line’s end moves onto it', lineEnd && Math.hypot(lineEnd[0] - 40, lineEnd[1] - 0) < 1e-6, JSON.stringify(lineEnd));
  await shot('sketch-linked-corner');
  // Use: the block's back edge, as a curve of the sketch.
  { const [a, b] = await toScreen(20, 30, 10); await clickAt(a, b - 1); }
  await settle(200);
  const usable = await page.$eval('[data-tool=use]', (e) => !e.disabled);
  await page.keyboard.press('u');
  await settle(500);
  sk = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.session().data)));
  const used = sk.entities.find((e) => e.type === 'projected' && e.from?.edge);
  check('Use brings a part’s edge in as a curve of the sketch', usable && !!used && used.construction === false && used.geometry?.type === 'line', JSON.stringify(used));
  // Drawing onto a corner ties to it, as Onshape's snapping does.
  await page.keyboard.press('l');
  await clickWorld(0, 30, 10);
  await clickWorld(10, 25, 10);
  await page.keyboard.press('Escape');
  await settle(500);
  sk = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.session().data)));
  // There the corner is also the end of the edge Use brought in, which follows the part just the same.
  const linkedIds = sk.entities.filter((e) => e.type === 'projected').map((e) => String(e.id));
  const newLine = Math.max(...sk.entities.filter((e) => e.type === 'line').map((e) => e.id));
  const tie = sk.constraints.find((c) => c.type === 'coincident' && [c.a, c.b].includes(`${newLine}.start`));
  check('a line started on a corner is tied to it', !!tie && [tie.a, tie.b].some((r) => linkedIds.includes(r.split('.')[0])), JSON.stringify(sk.constraints));
  // The kernel builds a sketch only if something in it closes, so a circle gives it one.
  await page.keyboard.press('c');
  await clickWorld(20, 15, 10);
  await clickWorld(24, 15, 10);
  await page.keyboard.press('Escape');
  await settle(500);
  await page.$eval('[data-testid=sketch-done]', (e) => e.click());
  await settle(800);
  let s = await state();
  const sketchFeature = s.features.find((f) => f.type === 'constrained_sketch');
  check('the sketch keeps its links', !!sketchFeature && sketchFeature.sketch.entities.filter((e) => e.type === 'projected').length === 2 && !s.failed, `${JSON.stringify(sketchFeature?.sketch.entities.map((e) => e.type))} ${s.failed}`);
  // Make the block longer: the tied end goes with its corner.
  await mutate('feature_edit', { id: 1, feature: { type: 'solid', shape: 'box', dx: 60, dy: 30, dz: 10 } });
  await settle(400);
  s = await state();
  const sf = s.features.find((f) => f.type === 'constrained_sketch');
  const solved = await page.evaluate((f, i) => window.schmishape.engine.call('sketch_solve', { sketch: f.sketch, context: { plane: f.plane, position: i } }).then((r) => JSON.parse(r.text).sketch), sf, s.features.indexOf(sf));
  const end = solved.entities.find((e) => e.id === 1)?.end;
  check('when the block grows, the tied point follows its corner', end && Math.hypot(end[0] - 60, end[1]) < 1e-6 && !s.failed, `${JSON.stringify(end)} ${s.failed}`);
}

console.log('Renaming and coloring parts');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 40, dy: 30, dz: 10 }, name: 'Block' });
  await mutate('feature_add', { feature: { type: 'solid', shape: 'sphere', radius: 8, at: { origin: [60, 15, 8] }, mode: 'new_body' }, name: 'Ball' });
  await settle(300);
  await fit();
  const partRow = (body) => page.$(`.parts [data-body="${body}"]`);
  const rowName = (body) => page.$eval(`.parts [data-body="${body}"] .feature-name`, (e) => e.textContent);
  const menuOn = async (body, item) => {
    const b = await (await partRow(body)).boundingBox();
    await page.mouse.click(b.x + 40, b.y + 10, { button: 'right' });
    await wait(150);
    const items = await page.$$eval('.menu [data-item]', (m) => m.map((x) => x.dataset.item));
    if (item) { await page.$eval(`.menu [data-item="${item}"]`, (e) => e.click()); await settle(300); }
    return items;
  };
  const items = await menuOn('f1');
  check('a part’s menu has Rename and Edit appearance', items.includes('Rename') && items.includes('Edit appearance…'), JSON.stringify(items));
  await page.keyboard.press('Escape');
  await menuOn('f1', 'Rename');
  await page.keyboard.type('Bracket');
  await page.keyboard.press('Enter');
  await settle(400);
  let app = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.doc.app)));
  check('Rename gives the part a name of its own', (await rowName('f1')) === 'Bracket' && app.parts?.f1?.name === 'Bracket', `${await rowName('f1')} ${JSON.stringify(app)}`);
  await menuOn('f2', 'Edit appearance…');
  check('Edit appearance opens a dialog for that part', (await page.$eval('[data-testid=appearance] h3', (e) => e.textContent)) === 'Appearance of Part 2');
  await page.$eval('[data-color="#3f6fb0"]', (e) => e.click());
  await settle(200);
  await shot('appearance-trying');
  app = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.doc.app)));
  check('trying a color doesn’t keep it yet', !app.parts?.f2?.color, JSON.stringify(app));
  await page.$eval('[data-testid=appearance-ok]', (e) => e.click());
  await settle(400);
  app = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.doc.app)));
  check('✓ keeps it with the document', app.parts?.f2?.color === '#3f6fb0' && app.parts?.f1?.name === 'Bracket', JSON.stringify(app));
  check('and the list shows it on the icon', !!(await page.$('.parts [data-body="f2"] .part-icon.tinted')));
  await page.mouse.move(700, 600);
  await shot('appearance-kept');
  await page.mouse.move(700, 20);
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await settle(400);
  app = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.doc.app)));
  check('undo takes the color back', !app.parts?.f2?.color && app.parts?.f1?.name === 'Bracket', JSON.stringify(app));
  await menuOn('f2', 'Edit appearance…');
  await page.$eval('[data-color="#b8433a"]', (e) => e.click());
  await page.keyboard.press('Escape');
  await settle(300);
  app = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.doc.app)));
  check('Esc leaves it as it was', !(await page.$('[data-testid=appearance]')) && !app.parts?.f2?.color, JSON.stringify(app));
  await (await partRow('f1')).click({ count: 2 });
  await settle(200);
  await page.$eval('.parts .feature-rename', (e) => { e.focus(); e.select(); });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await settle(400);
  app = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.doc.app)));
  check('clearing the name, from a double-click, goes back to Part 1', (await rowName('f1')) === 'Part 1' && !app.parts, `${await rowName('f1')} ${JSON.stringify(app)}`);
}

console.log('Revolve and loft take regions');
{
  await fresh();
  await mutate('feature_add', { feature: sketch([...rect(1, 10, 0, 10, 30), ...rect(5, 30, 0, 10, 30)]), name: 'Sketch 1' });
  await settle(300);
  await fit();
  await cmd('revolve');
  let s = await state();
  const ring = (a, b) => Math.PI * (b * b - a * a) * 30;
  check('a revolve starts with all of the last sketch', near(s.volume, ring(10, 20) + ring(30, 40), 1e-3), `${s.volume}`);
  check('and, with its regions there, the axis box takes the clicks', (await activeBox()) === 'axis', `${await activeBox()}`);
  await page.$eval('[data-pick=regions]', (e) => e.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await settle(200);
  await clickWorld(35, 15, 0);
  s = await state();
  check('a click drops one region', near(s.volume, ring(10, 20), 1e-3) && JSON.stringify(await rows('regions')) === '["Region of Sketch 1"]', `${s.volume} ${JSON.stringify(await rows('regions'))}`);
  await accept();
  s = await state();
  const idA = await regionId(s, 1, 300);
  check('the revolve lists its region', last(s).sketch === 1 && JSON.stringify(last(s).regions) === JSON.stringify([idA]), JSON.stringify(last(s)));
  await mutate('feature_add', { feature: sketch(rect(1, 50, 0, 10, 30)), name: 'Sketch 2', position: 1 });
  await settle(300);
  await fit();
  s = await state();
  await edit(last(s).id);
  await clickWorld(55, 15, 0);
  s = await state();
  const idC = await regionId(s, s.features.find((f) => f.name === 'Sketch 2').id, 300);
  check('a region of another sketch in the same plane joins it', JSON.stringify(last(s).regions) === JSON.stringify([idA, { sketch: s.features.find((f) => f.name === 'Sketch 2').id, region: idC }]) && near(s.volume, ring(10, 20) + ring(50, 60), 1e-3), `${JSON.stringify(last(s).regions)} ${s.volume}`);
  await shot('revolve-regions');
  await accept();

  await fresh();
  await mutate('feature_add', { feature: sketch([circle(1, 0, 0, 10), circle(2, 50, 0, 10)]), name: 'Base' });
  await mutate('feature_add', { feature: sketch([circle(1, 0, 0, 5)], [0, 0, 30]), name: 'Top' });
  await settle(300);
  await fit();
  await cmd('loft');
  check('a loft’s profiles box takes the clicks', (await activeBox()) === 'sections', `${await activeBox()}`);
  await clickWorld(0, 0, 0);
  await clickWorld(0, 0, 30);
  s = await state();
  const r = await rows('sections');
  check('profiles are listed in the order they’re clicked', JSON.stringify(r) === '["1. Region of Base","2. Region of Top"]', JSON.stringify(r));
  const base = await regionId(s, 1, Math.PI * 100);
  check('one region of a sketch with two outlines can be a profile', JSON.stringify(last(s).sections) === JSON.stringify([{ sketch: 1, region: base }, 2]), JSON.stringify(last(s).sections));
  const frustum = Math.PI * 30 / 3 * (100 + 50 + 25);
  check('and the loft runs between them', near(s.volume, frustum, 1e-2) && s.valid, `${s.volume} vs ${frustum}`);
  await shot('loft-regions');
  await clickWorld(0, 0, 0);
  check('clicking a profile again drops it', JSON.stringify(await rows('sections')) === '["1. Region of Top"]', JSON.stringify(await rows('sections')));
  await page.keyboard.press('Escape');
  await settle(400);
}

console.log('A fillet round a whole rim, 2 to 4 and back');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'cylinder', radius: 20, height: 20 } });
  await settle(400);
  const before = (await state()).volume;
  await page.evaluate(() => window.schmishape.startFeature('fillet'));
  await settle(400);
  await page.evaluate(() => window.schmishape.dialogSetValue('edges', [{ between: ['f1:end', 'f1:side.0'] }]));
  await page.$eval('[data-group=variable] input[data-field=variable]', (e) => e.click());
  await settle(300);
  await typeInto('r0', '2');
  await page.$eval('[data-field=midOn]', (e) => e.click());
  await settle(300);
  await typeInto('rMid', '4');
  await typeInto('r1', '2');
  let s = await state();
  check('a radius halfway is written between the ends', JSON.stringify(last(s).sets?.[0].along) === '[{"at":0,"radius":2},{"at":0.5,"radius":4},{"at":1,"radius":2}]', JSON.stringify(last(s).sets?.[0].along));
  check('and the rim rounds over evenly, with no step where it starts', !s.failed && s.valid && s.volume < before - 100 && s.volume > before - 600, `${s.volume} from ${before}`);
  await accept();
  await edit(2);
  check('editing reads the halfway radius back', (await page.$eval('[data-field=midOn]', (e) => e.checked)) && (await page.$eval('[data-field=rMid]', (e) => e.value)) === '4');
  await page.keyboard.press('Escape');
  await settle(300);
}

console.log('A surface split by a surface');
{
  await fresh();
  await mutate('feature_add', { feature: sketch(rect(1, 0, 0, 20, 20)), name: 'Square' });
  await mutate('feature_add', { feature: { type: 'fill', sketch: 1 } });
  await mutate('feature_add', { feature: sketch([{ id: 1, type: 'line', start: [10, -5], end: [10, 25] }], [0, 0, -5]), name: 'Cut line' });
  await mutate('feature_add', { feature: { type: 'extrude', sketch: 3, length: 10, mode: 'surface' } });
  await settle(400);
  await mutate('feature_add', { feature: { type: 'split', tool: 'f4', bodies: ['f2'] } });
  await settle(500);
  const s = await state();
  check('comes apart into two surfaces beside the tool', !s.failed && s.parts.filter((p) => p.sheet).length === 3, JSON.stringify(s.parts));
}

console.log('Loft to a point, closed, along guides, with set ends');
{
  await fresh();
  await mutate('feature_add', { feature: sketch([circle(1, 0, 0, 10)]), name: 'Base' });
  await mutate('feature_add', { feature: sketch([{ id: 1, type: 'point', at: [0, 0] }], [0, 0, 30]), name: 'Tip' });
  await settle(300);
  await fit();
  await cmd('loft');
  await clickWorld(0, 0, 0);
  check('one profile isn’t a loft yet', !(await okEnabled()));
  await page.$eval('[data-field=endPoint]', (e) => e.click());
  await settle(300);
  check('ending at a point takes the clicks for it', (await activeBox()) === 'to', `${await activeBox()}`);
  await clickWorld(0, 0, 30);
  let s = await state();
  const cone = Math.PI * 100 * 30 / 3;
  check('a circle to a point is a cone', last(s).to?.sketch === 2 && last(s).sections.length === 1 && near(s.volume, cone, 1e-3), `${JSON.stringify(last(s))} ${s.volume} vs ${cone}`);
  const endButtons = await page.$$eval('[aria-label="End"] button', (b) => b.map((x) => [x.textContent, x.disabled]));
  check('a point’s end can be rounded over but not squared', JSON.stringify(endButtons) === '[["Free",false],["Normal",true],["Round",false]]', JSON.stringify(endButtons));
  const startButtons = await page.$$eval('[aria-label="Start"] button', (b) => b.map((x) => [x.textContent, x.disabled]));
  check('and an outline’s end the other way round', JSON.stringify(startButtons) === '[["Free",false],["Normal",false],["Round",true]]', JSON.stringify(startButtons));
  await clickSegment('End', 'Round');
  s = await state();
  check('rounded over its point, it’s a dome, fuller than the cone', (last(s).end === 'round' || last(s).end?.round === 1) && s.volume > cone * 1.2 && s.valid, `${JSON.stringify(last(s).end)} ${s.volume}`);
  await typeInto('endPull', '2');
  s = await state();
  check('its pull is written with it', JSON.stringify(last(s).end) === '{"round":2}', JSON.stringify(last(s).end));
  await accept();
  check('it is added', (await state()).features.at(-1).type === 'loft' && !(await dialogOpen()));
  await edit((await state()).features.at(-1).id);
  check('editing reads its point and end back', (await page.$eval('[data-field=endPoint]', (e) => e.checked)) && (await page.$eval('[data-field=endPull]', (e) => e.value)) === '2' && /Tip|Sketch point/.test(JSON.stringify(await rows('to'))), JSON.stringify(await rows('to')));
  await page.keyboard.press('Escape');
  await settle(400);

  await fresh();
  await mutate('feature_add', { feature: sketch([circle(1, 0, 0, 10)]), name: 'Bottom' });
  await mutate('feature_add', { feature: sketch([circle(1, 0, 0, 15)], [0, 0, 30]), name: 'Top' });
  await mutate('feature_add', { feature: { type: 'constrained_sketch', plane: { origin: [0, 0, 0], z: [0, -1, 0], x: [1, 0, 0] }, sketch: { format: 'coreshape-sketch', version: 1, entities: [{ id: 1, type: 'line', start: [10, 0], end: [18, 15] }, { id: 2, type: 'line', start: [18, 15], end: [15, 30] }], constraints: [] } }, name: 'Guide' });
  await settle(300);
  await fit();
  await cmd('loft');
  await clickWorld(0, 0, 0);
  await clickWorld(0, 0, 30);
  s = await state();
  const plain = s.volume;
  check('two profiles loft straight', near(plain, Math.PI * 30 / 3 * (100 + 150 + 225), 1e-3), `${plain}`);
  await page.$eval('[data-field=guides] [data-sketch="3"]', (e) => e.click());
  await settle(600);
  s = await state();
  check('ticking a guide bends the sides out to it', JSON.stringify(last(s).guides) === '[3]' && s.volume > plain * 1.005 && s.valid, `${JSON.stringify(last(s).guides)} ${s.volume} vs ${plain}`);
  await clickSegment('Start', 'Normal');
  s = await state();
  const both = await dialogError();
  check('the kernel says a loft can’t yet follow guides and set its ends', !!both || s.failed, `${both}`);
  await clickSegment('Start', 'Free');
  await page.$eval('[data-field=guides] [data-sketch="3"]', (e) => e.click());
  await clickSegment('Start', 'Normal');
  s = await state();
  check('leaving square to the first profile changes the sides', (last(s).start === 'normal' || last(s).start?.normal === 1) && !near(s.volume, plain, 1e-3) && s.valid, `${JSON.stringify(last(s).start)} ${s.volume}`);
  await page.keyboard.press('Escape');
  await settle(400);

  await fresh();
  const ring = (deg) => {
    const a = (deg * Math.PI) / 180;
    return { type: 'constrained_sketch', plane: { origin: [30 * Math.cos(a), 30 * Math.sin(a), 0], z: [-Math.sin(a), Math.cos(a), 0], x: [Math.cos(a), Math.sin(a), 0] }, sketch: { format: 'coreshape-sketch', version: 1, entities: [circle(1, 0, 0, 5)], constraints: [] } };
  };
  for (const d of [0, 90, 180, 270]) await mutate('feature_add', { feature: ring(d) });
  await mutate('feature_add', { feature: { type: 'loft', sections: [1, 2, 3, 4], closed: true } });
  await settle(500);
  s = await state();
  const torus = 2 * Math.PI * Math.PI * 30 * 25;
  check('a closed loft makes a ring', near(s.volume, torus, 0.04) && s.valid, `${s.volume} vs ${torus}`);
  await edit(5);
  check('its dialog shows it closed, with no ends to set', (await page.$eval('[data-field=closed]', (e) => e.checked)) && !(await page.$('[aria-label="Start"]')) && !(await page.$('[data-field=guides]')));
  await page.$eval('[data-field=closed]', (e) => e.click());
  await settle(500);
  s = await state();
  check('open, it stops at the last profile', !last(s).closed && s.volume < torus * 0.9, `${s.volume}`);
  await page.keyboard.press('Escape');
  await settle(400);
}

console.log('Constraint tools wait for their picks');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 40, dy: 30, dz: 10 }, name: 'Block' });
  await settle(300);
  await fit();
  await page.evaluate(() => document.querySelector('[data-command="sketch"]').click());
  await settle(300);
  await clickWorld(20, 15, 10);
  await settle(600);
  await page.waitForFunction(() => !!window.schmishape.session()?.part, { timeout: 5000 }).catch(() => {});
  await page.keyboard.press('l');
  await clickWorld(5, 5, 10);
  await clickWorld(15, 8, 10);
  await page.keyboard.press('Escape');
  await clickWorld(25, 12, 10);
  await clickWorld(32, 20, 10);
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  await settle(400);
  const sess = () => page.evaluate(() => { const s = window.schmishape.session(); return { tool: s.constraintTool[0](), sel: s.selection[0](), data: JSON.parse(JSON.stringify(s.data)) }; });
  const pressed = () => page.$eval('[data-constraint=coincident]', (e) => e.getAttribute('aria-pressed'));
  check('Coincident can be clicked with nothing selected', await page.$eval('[data-constraint=coincident]', (e) => !e.disabled));
  await page.$eval('[data-constraint=coincident]', (e) => e.click());
  await settle(150);
  check('and then it stays on, waiting for picks', (await pressed()) === 'true' && (await sess()).tool === 'coincident');
  check('the status bar says what it takes', /^Coincident takes two points/.test(await page.$eval('.status-left', (e) => e.textContent)), await page.$eval('.status-left', (e) => e.textContent));
  const before = (await sess()).data.constraints.length;
  await clickWorld(15, 8, 10);
  check('one pick waits for the second', (await sess()).sel.length === 1 && (await sess()).data.constraints.length === before);
  await clickWorld(25, 12, 10);
  await settle(500);
  let st = await sess();
  const made = st.data.constraints.slice(before);
  check('the second makes them coincident', made.length === 1 && made[0].type === 'coincident' && st.sel.length === 0, JSON.stringify(made));
  check('and the tool stays on for the next pair', (await pressed()) === 'true');
  await shot('coincident-tool');
  // A line's end and a part's corner.
  await clickWorld(32, 20, 10);
  { const [a, b] = await toScreen(40, 30, 10); await clickAt(a - 1, b + 1); }
  await settle(500);
  st = await sess();
  const linked = st.data.entities.find((e) => e.type === 'projected');
  const end = st.data.entities.find((e) => e.type === 'line' && Math.hypot(e.end[0] - 40, e.end[1] - 30) < 1e-6);
  check('a point and a part’s corner work the same way', !!linked && !!end, JSON.stringify(st.data.entities.map((e) => [e.type, e.end])));
  // Two lines can't be coincident: it says why and starts again from the last pick.
  const lines = st.data.entities.filter((e) => e.type === 'line');
  const mid = (e) => [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2];
  await clickWorld(...mid(lines[0]), 10);
  await clickWorld(...mid(lines[1]), 10);
  await settle(200);
  const said = await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '));
  check('two lines say what Coincident takes', /Coincident takes two points, or a point and a curve/.test(said) && (await sess()).sel.length === 1, `${said} ${JSON.stringify((await sess()).sel)}`);
  await page.keyboard.press('Escape');
  await settle(150);
  check('Esc turns the tool off', (await pressed()) === 'false' && (await sess()).tool === null);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await settle(300);
}

console.log('Merge scope: which parts an Add or a Remove acts on');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 20, dy: 20, dz: 10, mode: 'new_body' }, name: 'Left' });
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 20, dy: 20, dz: 10, at: { origin: [30, 0, 0] }, mode: 'new_body' }, name: 'Right' });
  // A bar across the tops of both blocks.
  await mutate('feature_add', { feature: sketch(rect(1, -5, 8, 60, 4), [0, 0, 10]), name: 'Bar' });
  await settle(400);
  await fit();
  let s = await state();
  const bar = last(s).id;
  const startWith = async (id) => {
    await page.$eval(`[data-feature="${id}"]`, (e) => e.click());
    await settle(200);
    await cmd('extrude');
  };
  await startWith(bar);
  check('Add starts merging with all parts', await page.$eval('[data-field=mergeAll]', (e) => e.checked) && !(await page.$('[data-pick=scope]')));
  await typeInto('length', '4');
  s = await state();
  check('so the bar joins both blocks into one', s.parts.length === 1 && last(s).bodies === undefined, `${s.parts.length} ${JSON.stringify(last(s).bodies)}`);
  await page.$eval('[data-field=mergeAll]', (e) => e.click());
  await settle(500);
  check('turning it off shows the parts box, taking the clicks', (await activeBox()) === 'scope' && (await page.$eval('[data-pick=scope] .pick-label', (e) => e.textContent)) === 'Parts to merge with', `${await activeBox()}`);
  check('and it waits for a part', !(await okEnabled()) && (await page.$eval('[data-testid=dialog-ok]', (e) => e.dataset.tip)) === 'Click the parts to merge with');
  s = await state();
  check('meanwhile the bar shows as a part of its own', s.parts.length === 3 && last(s).mode === 'new_body', `${s.parts.length} ${last(s).mode}`);
  await clickWorld(10, 0, 5);
  check('a click on the left block picks it', JSON.stringify(await rows('scope')) === '["Part 1"]', JSON.stringify(await rows('scope')));
  await accept();
  s = await state();
  check('the bar joins only the left block', s.parts.length === 2 && JSON.stringify(last(s).bodies) === '["f1"]' && last(s).mode === 'add', `${s.parts.length} ${JSON.stringify(last(s))}`);
  check('which keeps the right one as it was', near(s.volume, 2 * 4000 + 60 * 4 * 4, 1e-3), `${s.volume}`);
  const added = last(s).id;
  await edit(added);
  check('editing reads the scope back', !(await page.$eval('[data-field=mergeAll]', (e) => e.checked)) && JSON.stringify(await rows('scope')) === '["Part 1"]', JSON.stringify(await rows('scope')));
  await page.$eval('[data-field=mergeAll]', (e) => e.click());
  await settle(500);
  s = await state();
  check('turning Merge with all back on clears the scope', s.features.find((f) => f.id === added).bodies?.length !== 1 && s.parts.length === 1, `${JSON.stringify(s.features.find((f) => f.id === added).bodies)} ${s.parts.length}`);
  await page.keyboard.press('Escape');
  await settle(400);
  s = await state();
  check('and Esc puts it back', JSON.stringify(s.features.find((f) => f.id === added).bodies) === '["f1"]' && s.parts.length === 2);

  // A slot across both blocks, cut from the right one only.
  await mutate('feature_add', { feature: sketch(rect(10, -5, 2, 60, 4), [0, 0, 10]), name: 'Slot' });
  await settle(400);
  const slot = last(await state()).id;
  await startWith(slot);
  await clickSegment('Result', 'Remove');
  check('Remove has its own words', (await page.$eval('label.check:has([data-field=mergeAll]) span', (e) => e.textContent)) === 'Remove from all');
  await page.$eval('[data-testid=flip-direction]', (e) => e.click());
  await settle(400);
  await typeInto('length', '3');
  await page.$eval('[data-field=mergeAll]', (e) => e.click());
  await settle(400);
  check('its box asks for the parts to cut', (await page.$eval('[data-pick=scope] .pick-label', (e) => e.textContent)) === 'Parts to remove from');
  await clickWorld(40, 0, 5);
  check('a click on the right block picks it', (await rows('scope')).length === 1, JSON.stringify(await rows('scope')));
  await shot('merge-scope-dialog');
  await accept();
  s = await state();
  check('the slot is cut from the right block only', JSON.stringify(last(s).bodies) === '["f2"]' && last(s).mode === 'remove' && near(s.volume, 2 * 4000 + 60 * 4 * 4 - 20 * 4 * 3, 1e-3) && !s.failed, `${s.volume} ${JSON.stringify(last(s))}`);
  await cmd('extrude');
  check('New has no scope', await page.$('[data-field=mergeAll]').then(async (e) => { await clickSegment('Result', 'New'); return !(await page.$('[data-field=mergeAll]')); }));
  await page.keyboard.press('Escape');
  await settle(400);
  await shot('merge-scope');
}

console.log('Mirror and pattern: of parts or of features');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 20, dy: 20, dz: 10, mode: 'new_body' }, name: 'Block' });
  await mutate('feature_add', { feature: { type: 'solid', shape: 'cylinder', radius: 3, height: 10, at: { origin: [10, 10, 0] }, mode: 'remove' }, name: 'Hole' });
  await mutate('feature_add', { feature: { type: 'solid', shape: 'cylinder', radius: 5, height: 10, at: { origin: [40, 0, 0] }, mode: 'new_body' }, name: 'Peg' });
  await settle(400);
  await fit();
  const block = 4000 - Math.PI * 90, peg = Math.PI * 250, hole = Math.PI * 90;
  await cmd('mirror');
  check('Mirror starts as a part mirror, taking clicks on parts', (await page.$eval('[data-field=copyType]', (e) => e.value)) === 'part' && (await activeBox()) === 'bodies', `${await activeBox()}`);
  let s = await state();
  check('with none picked it mirrors every part, as before', near(s.volume, 2 * (block + peg), 1e-3) && last(s).bodies === undefined, `${s.volume}`);
  await clickWorld(40, -4.9, 5);
  s = await state();
  check('a click on the peg mirrors only the peg', JSON.stringify(last(s).bodies) === '["f3"]' && near(s.volume, block + 2 * peg, 1e-3), `${s.volume} ${JSON.stringify(last(s).bodies)}`);
  await accept();
  await edit(last(await state()).id);
  check('editing reads the parts back', JSON.stringify(await rows('bodies')) === '["Part 2"]', JSON.stringify(await rows('bodies')));
  await page.keyboard.press('Escape');
  await settle(400);

  await cmd('pattern-linear');
  await select('copyType', 'feature');
  check('Feature pattern hands the clicks to its features box', (await activeBox()) === 'of' && !(await okEnabled()), `${await activeBox()}`);
  await page.$eval('[data-feature="2"]', (e) => e.click());
  await settle(400);
  check('a click on the hole in the list picks it', JSON.stringify(await rows('of')) === '["Hole"]', JSON.stringify(await rows('of')));
  check('and lights its row, and only the picks', JSON.stringify(await page.$$eval('.feature-row.selected', (r) => r.map((x) => x.dataset.feature))) === '["2"]', JSON.stringify(await page.$$eval('.feature-row.selected', (r) => r.map((x) => x.dataset.feature))));
  check('the dialog stays open', await dialogOpen());
  await typeInto('count', '2');
  await typeInto('spacing', '6');
  s = await state();
  check('the pattern copies the hole', JSON.stringify(last(s).of) === '[2]' && near(s.volume, block - hole + 2 * peg, 1e-3) && !s.failed, `${s.volume} ${JSON.stringify(last(s))}`);
  await clickWorld(40, 0, 10);
  check('a face the peg made picks its feature', JSON.stringify(await rows('of')) === '["Hole","Peg"]', JSON.stringify(await rows('of')));
  await page.$eval('[data-feature="3"]', (e) => e.click());
  await settle(400);
  check('clicking it in the list again drops it', JSON.stringify(await rows('of')) === '["Hole"]', JSON.stringify(await rows('of')));
  await shot('feature-pattern');
  await accept();
  s = await state();
  check('the feature pattern is added', last(s).type === 'pattern' && JSON.stringify(last(s).of) === '[2]' && !(await dialogOpen()), JSON.stringify(last(s)));
  await edit(last(s).id);
  check('and reads back as one', (await page.$eval('[data-field=copyType]', (e) => e.value)) === 'feature' && JSON.stringify(await rows('of')) === '["Hole"]');
  await page.keyboard.press('Escape');
  await settle(400);

  await cmd('fillet');
  check('Fillet has Tangent propagation, on', await page.$eval('[data-field=propagate]', (e) => e.checked));
  await clickWorld(10, 0, 10);
  await page.$eval('[data-field=propagate]', (e) => e.click());
  await settle(500);
  s = await state();
  check('turning it off writes it off', last(s).type === 'fillet' && last(s).propagate === false && !s.failed, JSON.stringify(last(s)));
  await page.$eval('[data-field=propagate]', (e) => e.click());
  await settle(500);
  check('and back on, it’s on again', last(await state()).propagate !== false, JSON.stringify(last(await state())));
  await page.keyboard.press('Escape');
  await settle(400);
  await cmd('chamfer');
  check('Chamfer has it too', await page.$eval('[data-field=propagate]', (e) => e.checked));
  await page.keyboard.press('Escape');
  await settle(400);
}

console.log('Planes, as Onshape’s Plane feature');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 40, dy: 30, dz: 20, mode: 'new_body' }, name: 'Block' });
  // A sketch in front of the block: a closed outline, whose ends and line planes can use, and a point of its own.
  await mutate('feature_add', { feature: sketch([...rect(1, 0, -30, 40, 10), { id: 5, type: 'point', at: [20, -40] }]), name: 'Marks' });
  await mutate('feature_add', { feature: { type: 'solid', shape: 'cylinder', radius: 5, height: 20, at: { origin: [60, 15, 0] }, mode: 'new_body' }, name: 'Peg' });
  await settle(400);
  await page.keyboard.press('0');
  await fit();
  const marks = 2;
  const planeOf = (id) => page.evaluate((id) => JSON.parse(JSON.stringify(window.schmishape.doc.planes.find((p) => p.id === id) ?? null)), id);
  const quads = () => page.evaluate(() => window.schmishape.view.renderer.planes.map((p) => p.id));
  const tip = () => page.$eval('[data-testid=dialog-ok]', (e) => e.dataset.tip);
  const hoverClick = async (p, dx = 4, dy = 3) => { const [x, y] = await toScreen(...p); await page.mouse.move(x + dx, y + dy); await wait(120); await clickAt(x + dx, y + dy); await settle(350); };
  const close = (a, b, tol = 1e-4) => a && b && a.length === b.length && a.every((c, i) => Math.abs(c - b[i]) < tol);

  await cmd('plane');
  check('Plane is in the toolbar, and opens as an offset plane', await dialogOpen() && (await page.$eval('[data-field=planeType]', (e) => e.value)) === 'offset' && (await activeBox()) === 'plane');
  check('it waits for a plane or a face', !(await okEnabled()) && (await tip()) === 'Click a plane or a flat face');
  await page.$eval('[data-plane="1"]', (e) => e.click());
  await settle(400);
  check('Top, clicked in the list, goes in', JSON.stringify(await rows('plane')) === '["Top plane"]', JSON.stringify(await rows('plane')));
  await typeInto('distance', '25');
  let s = await state();
  let made = last(s);
  check('an offset of Top is written as Onshape names it', made.type === 'plane' && made.plane_type === 'offset' && made.plane === 'top' && made.distance === 25, JSON.stringify(made));
  check('and the kernel puts it 25 up', close((await planeOf(made.id))?.origin, [0, 0, 25]), JSON.stringify(await planeOf(made.id)));
  check('it’s drawn while it’s being made', (await quads()).includes(1000 + made.id));
  await clickWorld(20, 15, 20);
  s = await state();
  made = last(s);
  check('a flat face takes Top’s place', made.plane === 'f1:end' && JSON.stringify(await rows('plane')) === '["Flat face"]' && close((await planeOf(made.id))?.origin, [0, 0, 45]), `${JSON.stringify(made)} ${JSON.stringify(await rows('plane'))}`);
  await shot('planes-offset');
  await accept();
  const offset = made.id;
  check('OK adds it, named Plane 1, with a plane icon and an eye', !(await dialogOpen()) && made.name === 'Plane 1' && !!(await page.$(`[data-feature="${offset}"] .row-eye`)));
  await edit(offset);
  check('editing reads it back', (await page.$eval('[data-field=planeType]', (e) => e.value)) === 'offset' && JSON.stringify(await rows('plane')) === '["Flat face"]' && (await page.$eval('[data-field=distance]', (e) => e.value)) === '25');
  const half = () => page.evaluate((q) => window.schmishape.view.renderer.planes.find((p) => p.id === q)?.half, 1000 + offset);
  const appOf = async () => (await state()).features.find((f) => f.id === offset).app;
  await page.$eval('[data-field=sizeOn]', (e) => e.click());
  await settle(400);
  await typeInto('size', '30');
  check('Display size sets how big it’s drawn, kept in its app data', (await appOf())?.size === 30 && near(await half(), 15), `${JSON.stringify(await appOf())} ${await half()}`);
  await page.$eval('[data-field=sizeOn]', (e) => e.click());
  await settle(400);
  check('and unticked, it goes', (await appOf())?.size === undefined && !near(await half(), 15), `${JSON.stringify(await appOf())} ${await half()}`);
  await page.keyboard.press('Escape');
  await settle(400);

  // A sketch on the plane follows it.
  await page.$eval(`[data-feature="${offset}"]`, (e) => e.click());
  await page.keyboard.down('Shift'); await page.keyboard.press('S'); await page.keyboard.up('Shift');
  await settle(300);
  const on = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.session()?.plane ?? null)));
  check('Shift S on a selected plane sketches on it', close(on?.origin, [0, 0, 45]) && close(on?.z, [0, 0, 1]), JSON.stringify(on));
  await page.keyboard.press('c');
  const [c1, c2] = [await toScreen(20, 15, 45), await toScreen(25, 15, 45)];
  await clickAt(...c1);
  await clickAt(...c2);
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await settle(600);
  s = await state();
  const disc = last(s);
  check('the sketch is written as on the plane', JSON.stringify(disc.plane) === JSON.stringify({ on_plane: offset }), JSON.stringify(disc.plane));
  await mutate('feature_add', { feature: { type: 'extrude', sketch: disc.id, length: 5, mode: 'new_body' }, name: 'Disc' });
  await settle(400);
  const top = () => page.evaluate(() => window.schmishape.doc.solid?.bounds_max[2] ?? 0);
  check('and its extrude sits on it', near(await top(), 50), `${await top()}`);
  await edit(offset);
  await typeInto('distance', '35');
  await accept();
  check('moving the plane moves the sketch and the extrude with it', near(await top(), 60) && !(await state()).failed, `${await top()}`);

  // Three points, picked at corners, in order.
  await cmd('plane');
  await select('planeType', 'three_point');
  check('Three point takes points', (await activeBox()) === 'points' && (await tip()) === 'Click 3 more points');
  for (const p of [[0, 0, 20], [40, 0, 0], [40, 30, 20]]) await hoverClick(p);
  check('three corners go in, numbered', JSON.stringify(await rows('points')) === '["1. Vertex","2. Vertex","3. Vertex"]', JSON.stringify(await rows('points')));
  await hoverClick([0, 0, 0]);
  check('a fourth doesn’t', (await rows('points')).length === 3);
  s = await state();
  made = last(s);
  const tilted = await planeOf(made.id);
  check('the plane goes through them', made.points?.length === 3 && made.points.every((p) => Array.isArray(p.faces)) && close(tilted?.origin, [0, 0, 20]) && close(tilted?.normal, [0.38411, -0.51215, 0.76822]), JSON.stringify(tilted));
  await shot('planes-three-point');
  await page.$eval('[data-testid=flip-direction]', (e) => e.click());
  await settle(400);
  check('Flip normal turns it round', last(await state()).flip === true && close((await planeOf(made.id))?.normal, [-0.38411, 0.51215, -0.76822]), JSON.stringify(await planeOf(made.id)));
  await accept();

  // Points and lines of a sketch.
  await cmd('plane');
  await select('planeType', 'mid_plane');
  await clickSegment('Between', 'Two points');
  await hoverClick([0, -30, 0], 0, 0);
  await hoverClick([40, -30, 0], 0, 0);
  made = last(await state());
  check('Mid plane between two sketch points', JSON.stringify(made.points) === JSON.stringify([{ sketch: marks, point: '1.start' }, { sketch: marks, point: '1.end' }]) && close((await planeOf(made.id))?.origin, [20, -30, 0]) && close((await planeOf(made.id))?.normal, [1, 0, 0]), JSON.stringify(made.points));
  await clickSegment('Between', 'Two planes');
  await page.$eval('[data-plane="1"]', (e) => e.click());
  await page.$eval(`[data-feature="${offset}"]`, (e) => e.click());
  await settle(400);
  made = last(await state());
  check('and between two planes, picked in the list', JSON.stringify(made.planes) === JSON.stringify(['top', offset]) && close((await planeOf(made.id))?.origin, [0, 0, 27.5]), `${JSON.stringify(made.planes)} ${JSON.stringify(await planeOf(made.id))}`);
  check('which lights their rows', (await page.$eval('[data-plane="1"]', (e) => e.classList.contains('selected'))) && (await page.$eval(`[data-feature="${offset}"]`, (e) => e.classList.contains('selected'))));
  await accept();

  await cmd('plane');
  await select('planeType', 'point_normal');
  check('Point normal asks for a point first', (await activeBox()) === 'point');
  await hoverClick([20, -40, 0], 0, 0);
  check('a sketch point goes in', JSON.stringify(last(await state()).point ?? (await rows('point'))) !== '[]' && (await rows('point')).length === 1, JSON.stringify(await rows('point')));
  check('and the line box takes the clicks next', (await activeBox()) === 'line', `${await activeBox()}`);
  await hoverClick([20, -30, 0], 0, 0);
  made = last(await state());
  check('a sketch line goes in, and the plane is square to it', JSON.stringify(made.point) === JSON.stringify({ sketch: marks, point: '5' }) && JSON.stringify(made.line) === JSON.stringify({ sketch: marks, line: 1 }) && close((await planeOf(made.id))?.origin, [20, -40, 0]) && close((await planeOf(made.id))?.normal, [1, 0, 0]), JSON.stringify(made));
  await accept();

  await cmd('plane');
  await select('planeType', 'line_angle');
  await clickWorld(20, 0, 20);
  await typeInto('degrees', '30');
  made = last(await state());
  check('Line angle about an edge', made.line?.between?.length === 2 && made.degrees === 30 && !(await dialogError()) && JSON.stringify(await rows('line')) === '["Straight edge"]', `${JSON.stringify(made)} ${JSON.stringify(await rows('line'))}`);
  await page.keyboard.press('Escape');
  await settle(400);

  await cmd('plane');
  await select('planeType', 'curve_point');
  await clickWorld(20, 0, 20);
  await typeInto('fraction', '0.25');
  made = last(await state());
  const cp = await planeOf(made.id);
  check('Curve point, a quarter along an edge', made.fraction === 0.25 && made.edge?.between?.length === 2 && close(cp?.normal.map(Math.abs), [1, 0, 0]) && (near(cp.origin[0], 10) || near(cp.origin[0], 30)), JSON.stringify(cp));
  await page.keyboard.press('Escape');
  await settle(400);

  await cmd('plane');
  await select('planeType', 'tangent');
  await clickWorld(63.5, 11.5, 10);
  await typeInto('degrees', '90');
  made = last(await state());
  const tp = await planeOf(made.id);
  check('Tangent plane on the peg, named for its whole surface', made.face === 'f3:side.0' && tp?.state !== 'failed' && near(Math.hypot(tp.origin[0] - 60, tp.origin[1] - 15), 5), JSON.stringify(made));
  await page.keyboard.press('Escape');
  await settle(400);

  await cmd('plane');
  await select('planeType', 'tangent');
  await clickWorld(20, 15, 20);
  check('a flat face for a tangent plane says why it won’t do', !!(await dialogError()), `${await dialogError()}`);
  await page.keyboard.press('Escape');
  await settle(400);

  // Planes in the view and the list.
  const offsetQuad = 1000 + offset;
  check('plane features are drawn', (await quads()).includes(offsetQuad));
  await page.$eval(`[data-feature="${offset}"] .row-eye`, (e) => e.click());
  await settle(400);
  check('the eye hides one, kept with the document', !(await quads()).includes(offsetQuad) && (await page.evaluate(() => JSON.stringify(window.schmishape.doc.app.hidden_planes))) === `[${offset}]`, `${JSON.stringify(await quads())} ${await page.evaluate(() => JSON.stringify(window.schmishape.doc.app))}`);
  await page.$eval(`[data-feature="${offset}"] .row-eye`, (e) => e.click());
  await settle(400);
  check('and shows it again', (await quads()).includes(offsetQuad));
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(1300, 800);
  await page.keyboard.press('p');
  await settle(400);
  check('P hides every plane, features too', (await quads()).length === 0, JSON.stringify(await quads()));
  await page.keyboard.press('p');
  await settle(400);
  check('and P shows them all', (await quads()).includes(offsetQuad) && (await quads()).includes(1));
  await page.keyboard.press('Escape');
  const menuItem = async (sel, item) => { await page.$eval(sel, (e) => e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 300 }))); await page.$eval(`[data-testid=context-menu] [data-item="${item}"]`, (e) => e.click()); await settle(500); };
  await menuItem('[data-feature="3"]', 'Roll to here');
  check('rolling back before a plane leaves it out', !(await quads()).includes(offsetQuad), JSON.stringify(await quads()));
  await menuItem('.rollback', 'Roll to end');
  check('and rolling forward brings it back', (await quads()).includes(offsetQuad));

  // Other features take planes.
  await cmd('mirror');
  check('Mirror’s plane is a box, starting with Right', JSON.stringify(await rows('plane')) === '["Right plane"]');
  await page.$eval('[data-pick=plane]', (e) => e.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await settle(200);
  await page.$eval(`[data-feature="${offset}"]`, (e) => e.click());
  await settle(500);
  made = last(await state());
  check('it mirrors across a plane feature', made.type === 'mirror' && made.plane === offset && !(await state()).failed, JSON.stringify(made));
  await accept();
  await edit(made.id);
  check('and reads it back', JSON.stringify(await rows('plane')) === '["Plane 1"]', JSON.stringify(await rows('plane')));
  await page.keyboard.press('Escape');
  await settle(400);

  await cmd('pattern-linear');
  await clickSegment('Direction', 'Line');
  check('a linear pattern can go along a line', (await activeBox()) === 'directionLine');
  await clickWorld(20, 0, 20);
  await typeInto('count', '2');
  await typeInto('spacing', '100');
  made = last(await state());
  check('picked as an edge', made.direction?.between?.length === 2 && !(await state()).failed, JSON.stringify(made));
  await page.keyboard.press('Escape');
  await settle(400);

  await cmd('pattern-circular');
  await clickSegment('Around', 'Line');
  await clickWorld(63.5, 11.5, 10);
  made = last(await state());
  check('a circular pattern goes round the axis of something round', made.axis?.axis_of === 'f3:side.0' && made.center === undefined && !(await state()).failed, JSON.stringify(made));
  await page.keyboard.press('Escape');
  await settle(400);

  await page.$eval(`[data-feature="${marks}"]`, (e) => e.click());
  await settle(200);
  await cmd('extrude');
  await select('end', 'up_to_face');
  check('Up to face takes the clicks', (await activeBox()) === 'endFace');
  await page.$eval(`[data-feature="${offset}"]`, (e) => e.click());
  await settle(500);
  made = last(await state());
  check('an extrude goes up to a plane, picked in the list', made.end?.type === 'up_to_face' && made.end.face === offset && !(await state()).failed && JSON.stringify(await rows('endFace')) === '["Plane 1"]', `${JSON.stringify(made.end)} ${JSON.stringify(await rows('endFace'))}`);
  await page.keyboard.press('Escape');
  await settle(400);

  await menuItem(`[data-feature="${offset}"]`, 'Delete');
  const said = await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' | '));
  check('a plane in use can’t be deleted, and says what uses it by name', /Plane 1 can.t be deleted while .*Sketch/.test(said) && !/\bf\d+\b/.test(said), said);
  await shot('planes');
}

console.log('Sheet metal, as Onshape’s');
{
  await fresh();
  await mutate('feature_add', { feature: sketch(rect(1, 0, 0, 60, 40)), name: 'Sketch 1' });
  await settle(300);
  await page.keyboard.press('0');
  await fit();
  const flat = () => page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.sheetParts())));
  const fact = (k) => page.$eval(`[data-fact=${k}]`, (e) => e.textContent).catch(() => null);
  const tableRows = () => page.$$eval('[data-testid=flat-table] tbody tr', (r) => r.map((x) => [...x.cells].map((c) => c.textContent)));
  const disabled = (id) => page.$eval(`[data-command="${id}"]`, (e) => e.disabled);
  const shown = (key) => page.$(`[data-field=${key}]`).then((e) => !!e);

  check('Flange and Flat pattern wait for a sheet metal part', (await disabled('flange')) && (await disabled('flat-pattern')) && !(await disabled('sheet-metal')));
  await cmd('sheet-metal');
  check('Sheet metal model opens on the last sketch', await dialogOpen() && (await page.$eval('[data-field=sketch]', (e) => e.value)) === '1');
  check('a closed outline has no Depth', !(await shown('depth')) && (await shown('thickness')) && (await shown('bendRadius')) && (await shown('kFactor')));
  let s = await state();
  let made = last(s);
  check('it’s written as the kernel’s sheet_metal', made.type === 'sheet_metal' && made.sketch === 1 && made.thickness === 2 && made.bend_radius === 2 && made.k_factor === 0.45 && made.depth === undefined && !s.failed, JSON.stringify(made));
  check('and makes a plate 2 thick', near(s.volume, 60 * 40 * 2), String(s.volume));
  await page.$eval('[data-testid=flip-direction]', (e) => e.click());
  await settle(500);
  made = last(await state());
  const flipped = made.flip === true;
  check('the flip button thickens the other side', flipped, JSON.stringify(made));
  if (flipped) { await page.$eval('[data-testid=flip-direction]', (e) => e.click()); await settle(500); }
  await accept();
  s = await state();
  const plate = last(s);
  check('OK adds it, named Sheet metal 1, with its icon', plate.name === 'Sheet metal 1' && !plate.flip && !!(await page.$(`[data-feature="${plate.id}"]`)));
  check('the part is listed as sheet metal', (await flat()).length === 1 && (await flat())[0].body === `f${plate.id}`, JSON.stringify(await flat()));

  check('Flat pattern is on now', !(await disabled('flat-pattern')) && !(await disabled('flange')));
  await cmd('flat-pattern');
  check('it opens beside the model', !!(await page.$('[data-testid=flat-panel]')) && (await page.$eval('[data-command="flat-pattern"]', (e) => e.getAttribute('aria-pressed'))) === 'true');
  check('a plate lies flat as it is: 60 × 40, no bends', (await fact('size')) === '60 × 40 mm' && (await fact('thickness')) === '2 mm' && (await fact('k')) === '0.45' && !(await page.$('[data-testid=flat-table]')), `${await fact('size')}`);

  await cmd('flange');
  check('Flange opens waiting for edges', await dialogOpen() && (await activeBox()) === 'edges');
  const tight = await page.evaluate(() => [...document.querySelectorAll('[data-testid=dialog] .segment button, [data-testid=dialog] .field-label, [data-testid=dialog] .check span')].filter((b) => b.scrollWidth > b.clientWidth + 1 && b.clientWidth > 0).map((b) => b.textContent));
  check('everything in it has room', tight.length === 0, tight.join());
  check('with Outer, 20 long, 90°, and the model’s bend radius', (await page.$eval('[aria-label=Alignment] button.on', (e) => e.textContent)) === 'Outer' && (await page.$eval('[data-field=length]', (e) => e.value)) === '20'
    && (await page.$eval('[data-field=degrees]', (e) => e.value)) === '90' && (await page.$eval('[data-field=modelRadius]', (e) => e.checked)) && !(await shown('bendRadius')));
  await clickWorld(60, 20, 2);
  s = await state();
  made = last(s);
  check('an edge along the top of the plate’s side takes a flange', made.type === 'flange' && JSON.stringify(made.edges.between?.slice().sort()) === JSON.stringify([`f${plate.id}:end`, `f${plate.id}:side.2`]) && made.length === 20 && made.degrees === 90 && (made.alignment ?? 'outer') === 'outer' && !s.failed, `${JSON.stringify(made)} ${s.failed}`);
  check('it’s listed as a straight edge', JSON.stringify(await rows('edges')) === '["Straight edge"]', JSON.stringify(await rows('edges')));
  check('the flat pattern follows the preview: one bend up', (await fact('size')) === '76.56 × 40 mm' && JSON.stringify(await tableRows()) === JSON.stringify([['Bend 1', 'Up', '90°', '2 mm', '4.56 mm']]), `${await fact('size')} ${JSON.stringify(await tableRows())}`);
  await clickSegment('Alignment', 'Inner');
  check('Inner puts the flange’s inside on the edge: 2 longer flat', last(await state()).alignment === 'inner' && (await fact('size')) === '78.56 × 40 mm', `${await fact('size')}`);
  await clickSegment('Alignment', 'Bend');
  check('Bend starts the bend at the edge', last(await state()).alignment === 'bend' && (await fact('size')) === '80.56 × 40 mm', `${await fact('size')}`);
  await clickSegment('Alignment', 'Outer');
  await page.$eval('[data-testid=flip-direction]', (e) => e.click());
  await settle(500);
  check('Flip direction bends it down', last(await state()).flip === true && (await tableRows())[0]?.[1] === 'Down', JSON.stringify(await tableRows()));
  await page.$eval('[data-testid=flip-direction]', (e) => e.click());
  await settle(500);
  await page.$eval('[data-field=modelRadius]', (e) => e.click());
  await settle(300);
  check('unticking the model’s radius gives the flange its own', await shown('bendRadius') && (await page.$eval('[data-field=bendRadius]', (e) => e.value)) === '2');
  await typeInto('bendRadius', '4');
  made = last(await state());
  check('and writes it', made.bend_radius === 4 && (await tableRows())[0]?.[3] === '4 mm', `${JSON.stringify(made)} ${JSON.stringify(await tableRows())}`);
  await page.$eval('[data-field=modelRadius]', (e) => e.click());
  await settle(500);
  check('ticked again, it’s gone', last(await state()).bend_radius === undefined);
  await typeInto('degrees', '45');
  check('the angle goes into the table', (await tableRows())[0]?.[2] === '45°', JSON.stringify(await tableRows()));
  await typeInto('degrees', '90');
  await shot('sheet-metal-flange');
  await accept();
  s = await state();
  const flange = last(s);
  check('OK adds Flange 1', flange.name === 'Flange 1' && !s.failed && s.valid !== false, `${flange.name} ${s.failed}`);
  await edit(flange.id);
  check('editing reads it back', JSON.stringify(await rows('edges')) === '["Straight edge"]' && (await page.$eval('[aria-label=Alignment] button.on', (e) => e.textContent)) === 'Outer' && (await page.$eval('[data-field=length]', (e) => e.value)) === '20');
  await page.keyboard.press('Escape');
  await settle(400);

  await page.$eval('[data-testid=flat-table] tbody tr', (e) => e.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false })));
  await wait(100);
  check('pointing at a row lights its bend line', await page.$eval('.flat-bend[data-bend="0"]', (e) => e.classList.contains('lit')));

  // The file a laser or a press brake takes, caught rather than saved.
  await page.evaluate(() => {
    window.__saved = null;
    window.showSaveFilePicker = async (o) => ({ createWritable: async () => ({ write: async (b) => { window.__saved = { name: o.suggestedName, text: await b.text() }; }, close: async () => {} }) });
  });
  await page.$eval('[data-testid=flat-dxf]', (e) => e.click());
  await settle(300);
  const dxf = await page.evaluate(() => window.__saved);
  const lines = dxf?.text.split('\n') ?? [];
  const count = (what, layer) => lines.filter((l, i) => l === what && lines[i - 1] === '0' && lines[i + 2] === layer).length;
  check('DXF: a .dxf in millimetres', !!dxf && /\.dxf$/.test(dxf.name) && dxf.text.includes('$INSUNITS\n70\n4') && dxf.text.trim().endsWith('EOF'), dxf?.name);
  check('the outline on OUTLINE, four lines', count('LINE', 'OUTLINE') === 4, String(count('LINE', 'OUTLINE')));
  check('the bend dashed on BEND_UP, with its note', count('LINE', 'BEND_UP') === 1 && dxf.text.includes('UP 90%%d R2') && dxf.text.includes('DASHED'), String(count('LINE', 'BEND_UP')));

  await edit(plate.id);
  await typeInto('thickness', '3');
  await typeInto('bendRadius', '3');
  await accept();
  s = await state();
  check('a thicker sheet: the flange follows and the flat pattern changes', !s.failed && (await fact('thickness')) === '3 mm' && (await tableRows())[0]?.[3] === '3 mm', `${s.failed} ${await fact('thickness')} ${JSON.stringify(await tableRows())}`);

  // A hole cut through the plate comes with it.
  await mutate('feature_add', { feature: sketch([circle(1, 20, 20, 5)]), name: 'Hole' });
  const hole = last(await state()).id;
  await mutate('feature_add', { feature: { type: 'extrude', sketch: hole, length: 10, start: -5, mode: 'remove' }, name: 'Cut' });
  await settle(400);
  check('a hole cut through it is in the flat pattern too', (await flat())[0].flat.outline.filter((e) => e.arc).length === 2 && (await page.$eval('.flat-sheet', (e) => (e.getAttribute('d').match(/M/g) ?? []).length)) === 2);
  await page.$eval('[data-testid=flat-dxf]', (e) => e.click());
  await settle(300);
  const holed = (await page.evaluate(() => window.__saved)).text.split('\n');
  check('and on HOLES in the DXF', holed.filter((l, i) => l === 'ARC' && holed[i - 1] === '0' && holed[i + 2] === 'HOLES').length === 2);

  // Lines that don't close: Onshape’s usual start. The sketch builds now, though it has no region.
  await mutate('feature_add', { feature: sketch([{ id: 1, type: 'line', start: [0, 20], end: [0, 0] }, { id: 2, type: 'line', start: [0, 0], end: [40, 0] }, { id: 3, type: 'line', start: [40, 0], end: [40, 15] }], [150, 0, 0]), name: 'Chain' });
  await settle(300);
  s = await state();
  const chain = last(s).id;
  check('a sketch of open lines builds', s.steps.find((x) => x.id === chain)?.state !== 'failed', JSON.stringify(s.steps.find((x) => x.id === chain)));
  await cmd('sheet-metal');
  await select('sketch', String(chain));
  check('a chain of lines has a Depth', await shown('depth'));
  await typeInto('depth', '30');
  s = await state();
  made = last(s);
  check('walls 30 deep with a bend at each corner', made.depth === 30 && made.sketch === chain && !s.failed, `${JSON.stringify(made)} ${s.failed}`);
  await accept();
  const bracket = last(await state());
  check('two parts now, and a list to choose between them', (await flat()).length === 2 && !!(await page.$('[data-testid=flat-part]')));
  await page.select('[data-testid=flat-part]', `f${bracket.id}`);
  await settle(200);
  // Outside 20, 40 and 15, 2 thick, bent 2 inside: flats of 16, 32 and 11, and two bends of π/2 × (2 + 0.45 × 2).
  check('the bracket lies flat with its two bends', (await tableRows()).length === 2 && (await tableRows()).every((r) => r[2] === '90°') && (await fact('size')) === '68.11 × 30 mm', `${await fact('size')} ${JSON.stringify(await tableRows())}`);

  // The rollback bar: before the flange there's no bend, and before the sheet metal there's nothing to lay flat.
  await page.select('[data-testid=flat-part]', `f${plate.id}`);
  await settle(200);
  const rollMenu = async (sel, item) => { await page.$eval(sel, (e) => e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 300 }))); await page.$eval(`[data-testid=context-menu] [data-item="${item}"]`, (e) => e.click()); await settle(500); };
  await rollMenu(`[data-feature="${plate.id}"]`, 'Roll to here');
  check('rolled back before the flange, the flat pattern has no bend', (await fact('size')) === '60 × 40 mm' && !(await page.$('[data-testid=flat-table]')), `${await fact('size')}`);
  await rollMenu('[data-feature="1"]', 'Roll to here');
  check('before the sheet metal, there’s nothing to lay flat', !!(await page.$('[data-testid=flat-empty]')) && (await flat()).length === 0);
  await page.$eval('.rollback', (e) => e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 300 })));
  await page.$eval('[data-testid=context-menu] [data-item="Roll to end"]', (e) => e.click());
  await settle(600);
  check('rolled to the end, both are back', (await flat()).length === 2 && (await tableRows()).length === 1, JSON.stringify(await tableRows()));
  await shot('sheet-metal');

  await page.$eval(`[data-body="f${plate.id}"]`, (e) => e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 500 })));
  await settle(200);
  check('a sheet metal part’s menu offers its flat pattern', !!(await page.$('[data-testid=context-menu] [data-item="Show flat pattern"]')));
  await page.keyboard.press('Escape');
  await settle(200);

  await page.$eval('[data-testid=flat-panel] [aria-label="Close the flat pattern"]', (e) => e.click());
  await settle(200);
  check('it closes', !(await page.$('[data-testid=flat-panel]')) && (await page.$eval('[data-command="flat-pattern"]', (e) => e.getAttribute('aria-pressed'))) === 'false');
}

for (const p of problems) console.log(`  problem: ${p}`);
console.log('Hole, rib, split, thin walls, scale and stretch');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 40, dy: 30, dz: 20, mode: 'new_body' }, name: 'Block' });
  await mutate('feature_add', { feature: sketch([{ id: 1, type: 'point', at: [10, 10] }, { id: 2, type: 'point', at: [30, 20] }], [0, 0, 20]), name: 'Hole points' });
  await settle(300);
  await fit();
  await cmd('hole');
  let s = await state();
  check('a hole starts at the last sketch’s points, M6 and blind', s.volume < 24000 && (await page.$eval('[data-field=size]', (e) => e.value)) === 'M6' && (await page.$eval('[data-field=end]', (e) => e.value)) === 'blind', `${s.volume}`);
  await select('end', 'through_all');
  s = await state();
  const bore = Math.PI * 3.3 ** 2 * 20;
  check('through all drills an M6 clearance hole, 6.6 mm, at each point', near(s.volume, 24000 - 2 * bore, 1e-3), `${s.volume} vs ${24000 - 2 * bore}`);
  await clickTab('Counterbore');
  const cb = (await state()).volume;
  check('a counterbore takes out more, DIN 974-1’s 6.4 deep for M6', near(cb, s.volume - 2 * Math.PI * (5.5 ** 2 - 3.3 ** 2) * 6.4, 1e-3), `${cb}`);
  await accept();
  s = await state();
  check('the hole is a feature of its own', last(s).type === 'hole' && last(s).style === 'counterbore' && last(s).size === 'M6' && last(s).end === 'through_all' && !s.failed, JSON.stringify(last(s)));
  const rowTip = async (id) => {
    await page.mouse.move(5, 5);
    await wait(100);
    await page.hover(`[data-feature="${id}"] .feature-name`);
    await wait(450);
    return page.$eval('.tooltip', (e) => e.textContent).catch(() => '');
  };
  const holeTip = await rowTip(last(s).id);
  check('its row says what a drawing would, once for alike holes', holeTip === '2 × M6 clearance, ⌀6.6 through, counterbore ⌀11 6.4 deep', holeTip);
  await edit(last(s).id);
  check('editing it shows what it was', (await page.$eval('[data-field=size]', (e) => e.value)) === 'M6' && (await page.$eval('[data-field=end]', (e) => e.value)) === 'through_all');
  await clickTab('Simple');
  await select('size', 'custom');
  await typeInto('diameter', '4');
  s = await state();
  check('a custom size takes the diameter typed', near(s.volume, 24000 - 2 * Math.PI * 4 * 20, 1e-3), `${s.volume}`);
  await accept();
  s = await state();
  check('and keeps it', last(s).diameter === 4 && last(s).size === undefined, JSON.stringify(last(s)));
  // Holes at the points picked, as in Onshape: a sketch's points, a circle's centre or a line's end.
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 40, dy: 30, dz: 20, mode: 'new_body' }, name: 'Block' });
  await mutate('feature_add', { feature: sketch([{ id: 1, type: 'point', at: [10, 10] }, { id: 2, type: 'point', at: [30, 20] }, { id: 3, type: 'circle', center: [20, 15], radius: 2, construction: true }], [0, 0, 20]), name: 'Hole points' });
  await settle(300);
  await fit();
  await cmd('hole');
  check('a hole takes every point of the last sketch to start with, and waits for more', JSON.stringify(await rows('at')) === '["1. Sketch point","2. Sketch point"]' && (await activeBox()) === 'at', `${JSON.stringify(await rows('at'))} ${await activeBox()}`);
  await select('end', 'through_all');
  await clickWorld(30, 20, 20);
  s = await state();
  check('clicking a picked point drops it', (await rows('at')).length === 1 && near(s.volume, 24000 - bore, 1e-3), `${JSON.stringify(await rows('at'))} ${s.volume}`);
  await clickWorld(20, 15, 20);
  s = await state();
  check('and a circle’s centre can be one', (await rows('at')).length === 2 && near(s.volume, 24000 - 2 * bore, 1e-3), `${JSON.stringify(await rows('at'))} ${s.volume}`);
  await clickWorld(40, 30, 20);
  check('a part’s corner isn’t a sketch point', (await rows('at')).length === 2, JSON.stringify(await rows('at')));
  await accept();
  s = await state();
  check('the hole names the points it takes', JSON.stringify(last(s).points) === '["1","3.center"]' && !s.failed, JSON.stringify(last(s)));
  await edit(last(s).id);
  check('and editing it shows them', (await rows('at')).length === 2, JSON.stringify(await rows('at')));
  await clickWorld(20, 15, 20);
  await clickWorld(30, 20, 20);
  await accept();
  s = await state();
  check('every point again is the sketch by itself, so points drawn later get holes', last(s).points === undefined && near(s.volume, 24000 - 2 * bore, 1e-3), `${JSON.stringify(last(s))} ${s.volume}`);

  await mutate('feature_add', { feature: sketch([{ id: 1, type: 'point', at: [20, 5] }], [0, 0, 20]), name: 'Tap point' });
  await mutate('feature_add', { feature: { type: 'hole', sketch: last(await state()).id, size: 'M5', tapped: true, end: 'blind', depth: 30 }, name: 'Deep tap' });
  await settle(300);
  s = await state();
  check('a blind hole deeper than the part is marked in the list', !!(await page.$(`[data-feature="${last(s).id}"] [data-testid=feature-note]`)), JSON.stringify(last(s)));
  const tapTip = await rowTip(last(s).id);
  check('with the thread and what the kernel noted', tapTip.startsWith('M5×0.8 tapped 30 deep') && tapTip.includes('so it goes right through'), tapTip);

  // Sheet metal stage 2: hems, a bend along a line, and closed corners.
  await fresh();
  await mutate('feature_add', { feature: sketch(rect(1, 0, 0, 60, 40)), name: 'Plate outline' });
  await mutate('feature_add', { feature: { type: 'sheet_metal', sketch: 1, thickness: 2, bend_radius: 2 }, name: 'Plate' });
  await settle(300);
  await fit();
  const bounds = () => page.evaluate(() => [...window.schmishape.doc.solid.bounds_min, ...window.schmishape.doc.solid.bounds_max]);
  await cmd('hem');
  check('Hem opens waiting for edges, Straight, with the model’s gap', await dialogOpen() && (await activeBox()) === 'edges' && (await page.$eval('[data-field=modelGap]', (e) => e.checked)));
  await clickWorld(60, 20, 2);
  s = await state();
  check('an edge of the wall takes a straight hem', last(s).type === 'hem' && last(s).kind === 'straight' && last(s).length === 10 && !s.failed && s.volume > 60 * 40 * 2, `${JSON.stringify(last(s))} ${s.failed} ${s.volume}`);
  const straightVolume = s.volume;
  await clickTab('Rolled');
  s = await state();
  check('Rolled has no length and turns 270°', last(s).kind === 'rolled' && last(s).length === undefined && last(s).degrees === 270 && !s.failed, `${JSON.stringify(last(s))} ${s.failed}`);
  await clickTab('Teardrop');
  s = await state();
  check('Teardrop turns 225°, and one coming back onto its wall is refused, in words', last(s).kind === 'teardrop' && last(s).degrees === 225 && /comes back down onto its own wall/.test(s.failed ?? ''), `${JSON.stringify(last(s))} ${s.failed}`);
  await typeInto('length', '3');
  s = await state();
  check('shorter, it builds', !s.failed && s.volume > 60 * 40 * 2, `${s.failed}`);
  await typeInto('length', '10');
  await clickTab('Straight');
  await accept();
  s = await state();
  check('OK adds Hem 1, with its icon', last(s).name === 'Hem 1' && near(s.volume, straightVolume, 1e-6) && !!(await page.$(`[data-feature="${last(s).id}"] .tool-art`)), `${last(s).name}`);
  await edit(last(s).id);
  check('editing it reads it back', JSON.stringify(await rows('edges')) === '["Straight edge"]' && (await page.$eval('[data-field=length]', (e) => e.value)) === '10');
  await page.keyboard.press('Escape');
  await settle(400);

  const flatSize = () => page.evaluate(() => window.schmishape.sheetParts()[0]?.flat?.size?.map((x) => x.toFixed(3)).join(' × '));
  const flatBefore = await flatSize();
  await mutate('feature_add', { feature: sketch([{ id: 1, type: 'line', start: [30, -5], end: [30, 45] }], [0, 0, 2]), name: 'Fold line' });
  await settle(300);
  await cmd('bend');
  s = await state();
  let [xMin, , , xMax, , zTop] = await bounds();
  check('Bend folds the side left of the line up', last(s).type === 'bend' && last(s).degrees === 90 && !s.failed && zTop > 20 && xMin > 20 && xMax > 59, `${JSON.stringify(last(s))} ${s.failed} ${await bounds()}`);
  await page.$eval('[data-field=otherSide]', (e) => e.click());
  await settle(500);
  s = await state();
  [xMin, , , xMax, , zTop] = await bounds();
  check('Move the other side folds the right side instead', last(s).moves === 'right' && !s.failed && zTop > 20 && xMin < 1 && xMax < 40, `${JSON.stringify(last(s))} ${s.failed} ${await bounds()}`);
  await accept();
  s = await state();
  check('OK adds Bend 1, and the flat pattern stays as it was', last(s).name === 'Bend 1' && !s.failed && (await flatSize()) === flatBefore, `${await flatSize()} vs ${flatBefore}`);

  await fresh();
  await mutate('feature_add', { feature: sketch(rect(1, 0, 0, 60, 40)), name: 'Plate outline' });
  await settle(300);
  await cmd('sheet-metal');
  check('Sheet metal model has Flange corners and a Minimal gap', (await page.$eval('[aria-label="Flange corners"] button.on', (e) => e.textContent)) === 'Open' && (await page.$eval('[data-field=minimalGap]', (e) => e.value)) === '0.2');
  await clickSegment('Flange corners', 'Closed');
  check('Closed is written for the folds after it', last(await state()).corner === 'closed' && last(await state()).minimal_gap === 0.2, JSON.stringify(last(await state())));
  await accept();
  await fit();
  await cmd('flange');
  await clickWorld(60, 20, 2);
  await clickWorld(30, 0, 2);
  s = await state();
  const closedVolume = s.volume;
  check('two flanges meeting at a corner close it', (await rows('edges')).length === 2 && !s.failed, `${JSON.stringify(await rows('edges'))} ${s.failed}`);
  await select('corner', 'open');
  s = await state();
  check('and a flange can leave it open, taking less', last(s).corner === 'open' && !s.failed && s.volume < closedVolume, `${s.volume} vs ${closedVolume}`);
  await page.keyboard.press('Escape');
  await settle(400);

  // A volume the kernel can't measure closely says how far out it can be.
  await fresh();
  await mutate('feature_add', { feature: { type: 'sketch', regions: [{ outer: { type: 'rect', x: -30, y: -22.5, w: 60, h: 45 } }] } });
  await mutate('feature_add', { feature: { type: 'sketch', plane: { origin: [0, 0, 44], z: [0, 0, 1], x: [1, 0, 0] }, regions: [{ outer: { type: 'circle', r: 14 } }] } });
  await mutate('feature_add', { feature: { type: 'sketch', plane: { origin: [0, 0, 80], z: [0, 0, 1], x: [1, 0, 0] }, regions: [{ outer: { type: 'ellipse', rx: 22, ry: 15.4 } }] } });
  await mutate('feature_add', { feature: { type: 'loft', sections: [1, 2, 3] } });
  await settle(300);
  check('a loft’s volume has no ±', !(await page.$eval('[data-testid=volume]', (e) => e.textContent)).includes('±'));
  await mutate('feature_add', { feature: { type: 'offset', distance: 0.25 } });
  await settle(300);
  const vol = await page.$eval('[data-testid=volume]', (e) => e.textContent);
  check('taken out a quarter, the status bar says how far out its volume can be', /±/.test(vol) && !!(await page.$('[data-testid=volume].status-rough')), vol);

  await fresh();
  const L = [[0, 0], [40, 0], [40, 4], [4, 4], [4, 40], [0, 40]].map((p, i, a) => ({ id: i + 1, type: 'line', start: p, end: a[(i + 1) % a.length] }));
  await mutate('feature_add', { feature: sketch(L), name: 'Angle' });
  await mutate('feature_add', { feature: { type: 'extrude', sketch: 1, length: 20, mode: 'new_body' }, name: 'Bracket' });
  await mutate('feature_add', { feature: sketch([{ id: 1, type: 'line', start: [30, 4], end: [4, 30] }], [0, 0, 10]), name: 'Rib line' });
  await settle(300);
  await fit();
  await cmd('rib');
  s = await state();
  check('a rib fills the corner of a bracket from a line across it', near(s.volume, 6756, 1e-3) && !s.failed, `${s.volume} ${s.failed}`);
  await page.click('[data-testid=flip-direction]');
  await settle(500);
  check('flipped, it runs off the part and says so', !!(await dialogError()), String(await dialogError()));
  await page.click('[data-testid=flip-direction]');
  await settle(500);
  await accept();
  s = await state();
  check('the rib is a feature of its own', last(s).type === 'rib' && last(s).thickness === 2 && s.parts.length === 1, JSON.stringify(last(s)));

  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 40, dy: 30, dz: 20, at: { origin: [-20, 0, 0] }, mode: 'new_body' }, name: 'Block' });
  await settle(300);
  await fit();
  await cmd('split');
  s = await state();
  check('a split by the Right plane cuts the part in two', s.parts.length === 2 && near(s.volume, 24000, 1e-6), `${s.parts.length} ${s.volume}`);
  await accept();
  s = await state();
  check('as a feature', last(s).type === 'split' && last(s).plane === 'right', JSON.stringify(last(s)));

  await fresh();
  await mutate('feature_add', { feature: sketch([{ id: 1, type: 'line', start: [0, 0], end: [30, 0] }, { id: 2, type: 'line', start: [30, 0], end: [30, 20] }]), name: 'Open curves' });
  await settle(300);
  await fit();
  await cmd('extrude');
  await page.click('[data-field=thinOn]');
  await settle(400);
  check('with Thin on, a sketch can be chosen', (await page.$eval('[data-field=sketch]', (e) => e.value)) === '', await page.$eval('[data-field=sketch]', (e) => e.value));
  await select('sketch', '1');
  await clickSegment('Side', 'Both');
  s = await state();
  check('a thin extrude makes a wall along open curves', near(s.volume, (30 + 20) * 2 * 20, 1e-3), `${s.volume}`);
  await accept();
  s = await state();
  check('kept as a thin extrude', JSON.stringify(last(s).thin) === JSON.stringify({ thickness: 2, side: 'both' }) && last(s).sketch === 1, JSON.stringify(last(s)));
  await edit(last(s).id);
  check('editing shows Thin on', await page.$eval('[data-field=thinOn]', (e) => e.checked));
  await page.keyboard.press('Escape');
  await settle(400);

  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 10, dy: 10, dz: 10, mode: 'new_body' }, name: 'Cube' });
  await settle(300);
  await fit();
  await cmd('transform');
  await clickWorld(5, 0, 5);
  await select('motion', 'scale');
  await typeInto('factor', '2');
  s = await state();
  check('Scale makes the cube twice the size', near(s.volume, 8000, 1e-6), `${s.volume}`);
  await accept();
  await fit();
  await cmd('transform');
  await clickWorld(5, 0, 5);
  await select('motion', 'stretch');
  await clickSegment('Axis', 'X');
  await typeInto('factor', '3');
  s = await state();
  check('Stretch along X makes it three times as long', near(s.volume, 24000, 1e-6), `${s.volume}`);
  await accept();
  s = await state();
  check('both are transforms', last(s).motion.type === 'stretch' && s.features[s.features.length - 2].motion.type === 'scale', JSON.stringify(last(s).motion));
  await mutate('feature_add', { feature: sketch([{ id: 1, type: 'line', start: [0, 0], end: [0, 10] }], [0, 0, 0]), name: 'Hinge' });
  await settle(200);
  const hinge = last(await state()).id;
  await mutate('feature_add', { feature: { type: 'transform', bodies: ['f1'], motion: { type: 'rotate', axis: { sketch: hinge, line: 1 }, degrees: 90 }, copy: true }, name: 'Turned' });
  await settle(300);
  s = await state();
  await edit(last(s).id);
  check('a rotate about a sketch line opens with the line', (await page.$eval('[aria-label=Axis] [aria-pressed=true]', (e) => e.textContent).catch(() => null)) === 'Line' || (await rows('axisLine')).length === 1, JSON.stringify(await rows('axisLine')));
  await page.keyboard.press('Escape');
  await settle(400);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
await browser.close();
process.exit(failures.length || problems.length ? 1 : 0);
