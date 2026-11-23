// Drawing tabs: made from a Part Studio, laid out by the kernel, with views, sections and dimensions added, the sheet and
// title block changed, undo, following the model, one part or an assembly as the source, export, and coming back after
// a reload. Usage: node scripts/smoke-drawing.mjs <url> <screenshot folder>
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5183/';
const out = process.argv[3] ?? '/tmp/schmishape-drawing';
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
/** Waits until the drawing isn't being laid out. */
const drawn = async () => { await wait(80); await page.waitForFunction(() => !window.schmishape.drawing.drawingBusy(), { timeout: 30000 }); await wait(60); };
const svg = () => page.evaluate(() => window.schmishape.drawing.rendered()?.svg ?? '');
const data = () => page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.drawing.drawingData())));
const error = () => page.evaluate(() => window.schmishape.drawing.drawingError());
const bar = () => page.$$eval('.tabbar .tab', (t) => t.map((x) => x.querySelector('.tab-name')?.textContent ?? ''));
const active = () => page.$$eval('.tabbar .tab.on .tab-name', (t) => t[0]?.textContent ?? null);
const clickTab = async (name) => {
  const b = await page.$$eval('.tabbar .tab', (t, n) => { const e = t.find((x) => x.querySelector('.tab-name')?.textContent === n); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }, name);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await settle(400);
};
const insertTab = async (command) => {
  await page.$eval('[data-testid=tab-insert]', (e) => e.click());
  await wait(80);
  await page.$eval(`.menu [data-command="${command}"]`, (e) => e.click());
  await settle(500);
};
const menuItem = async (button, command) => {
  await page.$eval(`[data-testid=${button}]`, (e) => e.click());
  await wait(80);
  await page.$eval(`.menu [data-command="${command}"]`, (e) => e.click());
  await drawn();
};
const toasts = () => page.$$eval('.toast', (t) => t.map((x) => x.textContent));
const mutate = (tool, args) => page.evaluate((t, a) => window.schmishape.mutate(t, a).then((r) => r.text), tool, args);
const ctrl = async (key) => { await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control'); await drawn(); };
const texts = (s) => [...s.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.schmishape?.doc, { timeout: 20000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('[data-testid=empty]', { timeout: 20000 });
await settle(400);

console.log('a plate with a hole');
await mutate('feature_add', { name: 'Plate', feature: { type: 'solid', shape: 'box', dx: 60, dy: 40, dz: 10 } });
await mutate('feature_add', { feature: { type: 'constrained_sketch', plane: { origin: [0, 0, 10] }, sketch: { format: 'coreshape-sketch', version: 1, entities: [{ id: 1, type: 'point', at: [30, 20] }, { id: 2, type: 'point', at: [10, 10] }], constraints: [] } } });
await mutate('feature_add', { feature: { type: 'hole', sketch: 2, points: ['1'], size: 'M6', end: 'through_all' } });
await settle(500);
check('the part is built', await page.evaluate(() => window.schmishape.doc.steps.every((s) => s.state !== 'failed')));

console.log('a drawing of it');
await insertTab('tab.drawing');
await page.waitForSelector('[data-testid=drawing-sheet]', { timeout: 30000 });
await drawn();
check('a Drawing tab opens beside the Part Studio', (await bar()).join() === 'Part Studio 1,Drawing 1,Assembly 1' && (await active()) === 'Drawing 1', (await bar()).join());
let d = await data();
check('it shows the Part Studio', d.source.tab === 't1' && !d.source.body);
check('with front, top, right and isometric views', d.drawing.views.map((v) => v.type).join() === 'front,top,right,iso');
check('on A3 in first-angle projection', d.drawing.sheet === 'A3' && d.drawing.projection === 'first_angle');
let s = await svg();
check('the kernel lays it out at a standard scale', /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(await page.$eval('[data-testid=drawing-sheet]', (e) => e.dataset.scale)), await page.$eval('[data-testid=drawing-sheet]', (e) => e.dataset.scale));
check('with overall sizes', texts(s).includes('60') && texts(s).includes('40') && texts(s).includes('10'), texts(s).slice(0, 12).join('|'));
check('and the hole\'s diameter', texts(s).some((t) => t.includes('6.6')), texts(s).filter((t) => t.includes('⌀') || t.includes('Ø')).join('|'));
check('the title block names it', texts(s).includes('Part Studio 1'));
check('the sidebar lists its views', (await page.$$('[data-testid=drawing-views] [data-view]')).length === 4);
check('the modelling tools are gone', !(await page.$('[aria-label="Modelling tools"]')) && !!(await page.$('[aria-label="Drawing sheet tools"]')));
check('nothing went wrong', !(await error()), await error());
await shot('d01-drawing');

console.log('adding a view');
await menuItem('drawing-insert-view', 'drawing.view.back');
d = await data();
check('a back view is added', d.drawing.views.some((v) => v.type === 'back') && (await page.$$('[data-testid=drawing-views] [data-view]')).length === 5);

console.log('a section');
await page.$eval('[data-testid=drawing-section]', (e) => e.click());
await settle(300);
check('the section form opens', !!(await page.$('[data-testid=section-form]')));
const offset = await page.$eval('[data-testid=section-offset]', (e) => e.value);
check('through the middle of the part', Number(offset) === 20, offset);
check('lettered A', (await page.$eval('[data-testid=section-letter]', (e) => e.value)) === 'A');
await page.$eval('[data-testid=section-ok]', (e) => e.click());
await drawn();
d = await data();
const sec = d.drawing.views.find((v) => v.type === 'section');
check('a section view is added', !!sec && sec.letter === 'A' && sec.normal.join() === '0,-1,0' && sec.point.join() === '0,20,0', JSON.stringify(sec));
s = await svg();
check('labelled SECTION A-A', s.includes('SECTION A-A'));
check('the form closes', !(await page.$('[data-testid=section-form]')));
await page.$eval('[data-testid=drawing-section]', (e) => e.click());
await settle(300);
check('the next one would be B', (await page.$eval('[data-testid=section-letter]', (e) => e.value)) === 'B');
await page.$eval('[data-section-axis=top]', (e) => e.click());
await page.$eval('[data-testid=section-offset]', (e) => { e.value = '-99'; e.dispatchEvent(new Event('input', { bubbles: true })); });
await page.$eval('[data-testid=section-ok]', (e) => e.click());
await drawn();
check('a section that misses the part is refused', (await data()).drawing.views.filter((v) => v.type === 'section').length === 1 && (await toasts()).some((t) => /misses/.test(t)), (await toasts()).join('|'));
check('and the drawing is as it was', !(await error()) && (await svg()).includes('SECTION A-A'));
await page.$eval('[data-testid=section-form] .dialog-action:not(.ok)', (e) => e.click());
await settle(200);

console.log('a dimension between sketch points');
await page.$eval('[data-testid=drawing-dimension]', (e) => e.click());
await settle(300);
const top = (await data()).drawing.views.find((v) => v.type === 'top').id;
await page.select('[data-testid=dimension-view]', String(top));
const opts = await page.$$eval('[data-testid=dimension-a] option', (o) => o.map((x) => [x.value, x.textContent]));
check('the sketch points are offered', opts.some(([, t]) => /point 1/.test(t)) && opts.some(([, t]) => /point 2/.test(t)), opts.map((o) => o[1]).join('|'));
await page.select('[data-testid=dimension-a]', opts.find(([, t]) => /point 2$/.test(t))[0]);
await page.select('[data-testid=dimension-b]', opts.find(([, t]) => /point 1$/.test(t))[0]);
await page.$eval('[data-along=horizontal]', (e) => e.click());
await page.$eval('[data-testid=dimension-text]', (e) => { e.value = '<> to the hole'; e.dispatchEvent(new Event('input', { bubbles: true })); });
await page.$eval('[data-testid=dimension-ok]', (e) => e.click());
await drawn();
d = await data();
const dim = d.drawing.dimensions[0];
check('the dimension is kept with its points', !!dim && dim.view === top && dim.a.sketch === 2 && dim.a.point === '2' && dim.b.point === '1' && dim.along === 'horizontal', JSON.stringify(dim));
s = await svg();
check('it measures 20 across', texts(s).includes('20 to the hole'), texts(s).filter((t) => /hole/.test(t)).join('|'));
check('and is listed', (await page.$$('[data-testid=drawing-dimensions] [data-dimension]')).length === 1);

console.log('a diameter where there is no circle');
await page.$eval('[data-testid=drawing-dimension]', (e) => e.click());
await settle(300);
await page.$eval('[data-dimension-type=diameter]', (e) => e.click());
await wait(80);
const front = (await data()).drawing.views.find((v) => v.type === 'front').id;
await page.select('[data-testid=dimension-view]', String(front));
const nearOpts = await page.$$eval('[data-testid=dimension-near] option', (o) => o.map((x) => [x.value, x.textContent]));
await page.select('[data-testid=dimension-near]', nearOpts.find(([, t]) => /point 1$/.test(t))[0]);
await page.$eval('[data-testid=dimension-ok]', (e) => e.click());
await drawn();
check('is refused with the kernel\'s reason', (await data()).drawing.dimensions.length === 1 && (await toasts()).some((t) => /dimension can't be drawn/.test(t)), (await toasts()).slice(-1).join());
check('the form stays open to change it', !!(await page.$('[data-testid=dimension-form]')));
await page.select('[data-testid=dimension-view]', String(top));
await page.$eval('[data-testid=dimension-ok]', (e) => e.click());
await drawn();
check('in the top view it finds the hole', (await data()).drawing.dimensions.length === 2 && (await data()).drawing.dimensions[1].type === 'diameter');

console.log('the sheet');
await page.select('[data-testid=drawing-sheet-size]', 'A2');
await drawn();
check('A2 is 594 wide', (await page.evaluate(() => window.schmishape.drawing.rendered().width)) === 594);
await page.$$eval('[data-testid=drawing-projection] button', (b) => b[1].click());
await drawn();
check('third angle projection', (await data()).drawing.projection === 'third_angle');
await page.select('[data-testid=drawing-scale]', '0.5');
await drawn();
check('a scale of 1:2', (await page.$eval('[data-testid=drawing-sheet]', (e) => e.dataset.scale)) === '1:2' && texts(await svg()).includes('1:2'));
await page.$eval('[data-testid=drawing-auto]', (e) => e.click());
await drawn();
check('without automatic dimensions the overall sizes go', !texts(await svg()).includes('60'), texts(await svg()).slice(0, 20).join('|'));
await page.$eval('[data-testid=drawing-auto]', (e) => e.click());
await drawn();

console.log('the title block');
await page.$eval('[data-testid=drawing-title-toggle]', (e) => e.click());
await settle(200);
await page.$eval('[data-title-field=material]', (e) => { e.value = 'S235'; e.dispatchEvent(new Event('change', { bubbles: true })); });
await drawn();
check('the material is written in it', texts(await svg()).includes('S235'));
await ctrl('z');
check('undo takes it out', !texts(await svg()).includes('S235') && !(await data()).drawing.title.material);
await page.keyboard.down('Shift'); await ctrl('z'); await page.keyboard.up('Shift');
check('redo puts it back', texts(await svg()).includes('S235'));
await shot('d02-edited');

console.log('deleting a view takes its dimensions');
const back = (await data()).drawing.views.find((v) => v.type === 'back').id;
await page.$eval(`[data-view="${back}"] [aria-label^="Delete"]`, (e) => e.click());
await drawn();
check('the back view is gone', !(await data()).drawing.views.some((v) => v.type === 'back'));
await page.$eval(`[data-view="${top}"] [aria-label^="Delete"]`, (e) => e.click());
await drawn();
check('the top view goes with its dimensions', (await data()).drawing.dimensions.length === 0);
await ctrl('z');
check('and undo brings them back', (await data()).drawing.dimensions.length === 2);

console.log('it follows the model');
await clickTab('Part Studio 1');
check('the Part Studio comes back as it was', await page.evaluate(() => window.schmishape.doc.features.length) === 3);
const plate = await page.evaluate(() => window.schmishape.doc.features[0].id);
await page.evaluate(async (id) => {
  await window.schmishape.mutate('feature_edit', { id, feature: { type: 'solid', shape: 'box', dx: 80, dy: 40, dz: 10 } });
}, plate);
await settle(500);
await clickTab('Drawing 1');
await drawn();
check('the drawing shows the new length', texts(await svg()).includes('80') && !texts(await svg()).includes('60'), texts(await svg()).slice(0, 12).join('|'));
check('and its own settings are kept', (await data()).drawing.sheet === 'A2' && (await data()).drawing.views.some((v) => v.type === 'section'));

console.log('one part');
await clickTab('Part Studio 1');
await mutate('feature_add', { name: 'Block', feature: { type: 'solid', shape: 'box', dx: 5, dy: 5, dz: 5, mode: 'new_body' } });
await settle(500);
await clickTab('Drawing 1');
await drawn();
await page.waitForFunction(() => document.querySelectorAll('[data-testid=drawing-part] option').length >= 3, { timeout: 20000 });
const partOpts = await page.$$eval('[data-testid=drawing-part] option', (o) => o.map((x) => [x.value, x.textContent]));
check('its parts are offered', partOpts.length === 3, partOpts.map((o) => o[1]).join('|'));
await page.select('[data-testid=drawing-part]', partOpts[1][0]);
await drawn();
await wait(300);
d = await data();
check('the drawing is of that part', d.source.body === partOpts[1][0] && !(await error()), await error());
check('the title block says which', d.drawing.title.part === `${partOpts[1][1]} of Part Studio 1`, d.drawing.title.part);
await page.select('[data-testid=drawing-part]', partOpts[2][0]);
await drawn();
check('a part the section misses says so', /section A's plane misses the part/.test((await error()) ?? ''), await error());
await page.select('[data-testid=drawing-part]', '');
await drawn();

console.log('export');
const exported = await page.evaluate(async () => {
  const d = window.schmishape.drawing.drawingData();
  const text = await window.schmishape.wholeText(window.schmishape.tabs.tabDocumentText('t1'));
  const out = {};
  for (const f of ['svg', 'pdf', 'dxf', 'png']) {
    const r = await window.schmishape.engine.drawing({ drawing: d.drawing, doc: text, format: f });
    out[f] = r.ok ? (f === 'pdf' || f === 'png' ? atob(r.data).slice(0, 8) : r.data.slice(0, 40)) : r.error;
  }
  return out;
});
check('SVG', exported.svg.startsWith('<?xml') || exported.svg.startsWith('<svg'), exported.svg);
check('PDF', exported.pdf.startsWith('%PDF'), exported.pdf);
check('DXF', /SECTION/.test(exported.dxf), exported.dxf);
check('PNG', exported.png.slice(1, 4) === 'PNG', exported.png);
await page.$eval('[data-testid=drawing-export]', (e) => e.click());
await wait(80);
check('the export menu offers all four', (await page.$$eval('.menu [data-command^="drawing.export."]', (m) => m.length)) === 4);
await page.keyboard.press('Escape');

console.log('an assembly');
await page.evaluate(() => {
  const pose = { p: [100, 0, 0], q: [0, 0, 0, 1] };
  const a = { format: 'schmishape-assembly', version: 1, instances: [
    { id: 'i1', tab: 't1', body: 'f1', number: 1, name: null, pose: { p: [0, 0, 0], q: [0, 0, 0, 1] }, fixed: true, hidden: false },
    { id: 'i2', tab: 't1', body: 'f1', number: 2, name: null, pose, fixed: false, hidden: false },
  ], mates: [], next: 3 };
  localStorage.setItem('schmishape.assembly.t2', JSON.stringify(a));
});
await page.select('[data-testid=drawing-source]', 't2');
await drawn();
await wait(300);
check('it draws the assembly\'s parts where they are', !(await error()) && texts(await svg()).includes('180'), `${await error()} ${texts(await svg()).slice(0, 10).join('|')}`);
check('there\'s no part to pick', !(await page.$('[data-testid=drawing-part]')));
await page.select('[data-testid=drawing-source]', 't1');
await drawn();

console.log('after a reload');
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('[data-testid=drawing-sheet]', { timeout: 30000 });
await drawn();
check('the drawing tab comes back open', (await active()) === 'Drawing 1');
d = await data();
check('with everything in it', d.drawing.sheet === 'A2' && d.drawing.dimensions.length === 2 && texts(await svg()).includes('S235'), `${d.drawing.sheet} ${d.drawing.dimensions.length} ${JSON.stringify(d.drawing.title)} ${await error()}`);

console.log('duplicate and delete');
await page.evaluate(() => window.schmishape.tabs.duplicateTab(window.schmishape.tabs.activeTabId()));
await drawn();
await settle(400);
check('a copy has the same drawing', (await active()) === 'Copy of Drawing 1' && (await data()).drawing.dimensions.length === 2);
await page.evaluate(() => window.schmishape.tabs.deleteTab(window.schmishape.tabs.activeTabId()));
await settle(500);
check('deleting it leaves the original', !(await bar()).includes('Copy of Drawing 1') && (await bar()).includes('Drawing 1'));

console.log('a deleted source');
await page.evaluate(() => window.schmishape.tabs.deleteTab('t1'));
await settle(500);
await clickTab('Drawing 1');
await drawn();
check('says so rather than failing', /deleted/.test((await error()) ?? ''), await error());
await shot('d03-deleted-source');

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const p of problems) console.log(`problem: ${p}`);
await browser.close();
process.exit(failures.length || problems.filter((p) => !/favicon|404/.test(p)).length ? 1 : 0);
