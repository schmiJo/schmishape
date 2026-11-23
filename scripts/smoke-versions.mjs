// Versions and whole-document files, in headless Chrome: create versions, restore one (which keeps the document as it
// was as a version first), and save the whole document to a file and open it again.
// Usage: node scripts/smoke-versions.mjs <url> <screenshot folder>
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5183/';
const out = process.argv[3] ?? '/tmp/schmishape-versions';
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
const ready = async () => { await page.waitForFunction(() => window.schmishape?.engine && document.querySelector('[data-testid=file-menu]')); await settle(800); };
const mutate = (tool, args) => page.evaluate((t, a) => window.schmishape.mutate(t, a).then((r) => r.text), tool, args);
const features = () => page.evaluate(() => window.schmishape.doc.features.map((f) => f.name));
const tabNames = () => page.evaluate(() => window.schmishape.tabs.tabs().map((t) => t.name));
const menu = async (id) => {
  await page.click('[data-testid=file-menu]');
  await wait(100);
  await page.$eval(`[data-command="${id}"]`, (e) => e.click());
  await settle(400);
};
const versionNames = () => page.$$eval('[data-version]', (v) => v.map((x) => x.dataset.version)).catch(() => []);
const box = (name, dz) => mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 20, dy: 20, dz, mode: 'new_body' }, name });

await page.goto(url, { waitUntil: 'networkidle0' });
await page.evaluate(async () => {
  localStorage.clear();
  await new Promise((r) => { const q = indexedDB.deleteDatabase('schmishape-versions'); q.onsuccess = q.onerror = q.onblocked = r; });
});
await page.goto(url, { waitUntil: 'networkidle0' });
await ready();

console.log('Versions');
await box('Base', 10);
await settle(300);
await menu('versions');
check('Versions opens a panel', !!(await page.$('[data-testid=versions-panel]')));
check('with nothing in it yet', (await versionNames()).length === 0);
check('the name offered is V1', (await page.$eval('[data-testid=version-name]', (e) => e.placeholder)) === 'V1');
await page.type('[data-testid=version-name]', 'First');
await page.type('[data-testid=version-description]', 'Just the base');
await page.click('[data-testid=version-create]');
await settle(500);
check('a version is created by name', JSON.stringify(await versionNames()) === '["First"]', JSON.stringify(await versionNames()));
check('with its description', (await page.$eval('[data-version=First] .version-description', (e) => e.textContent)) === 'Just the base');
await box('Top', 30);
await settle(300);
await page.click('[data-testid=version-create]');
await settle(500);
check('the next one is named V2 if left blank', JSON.stringify(await versionNames()) === '["V2","First"]', JSON.stringify(await versionNames()));
await shot('versions-two');

console.log('Restore');
await page.$eval('[data-version=First] [data-action=restore]', (e) => e.click());
await settle(200);
check('restoring asks first, in the panel', !!(await page.$('[data-version=First] .version-confirm')));
await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.$eval('[data-version=First] [data-action=confirm]', (e) => e.click())]);
await ready();
check('restoring brings the document back as it was', JSON.stringify(await features()) === '["Base"]', JSON.stringify(await features()));
await menu('versions');
const after = await versionNames();
check('and what was there is kept as a version first', after.length === 3 && after[0] === 'Before restoring First', JSON.stringify(after));
await page.$eval('[data-version="Before restoring First"] [data-action=restore]', (e) => e.click());
await settle(200);
await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.$eval('[data-version="Before restoring First"] [data-action=confirm]', (e) => e.click())]);
await ready();
check('which can be restored in turn', JSON.stringify(await features()) === '["Base","Top"]', JSON.stringify(await features()));

console.log('Delete a version');
await menu('versions');
await page.$eval('[data-version=V2] [data-action=delete]', (e) => e.click());
await settle(200);
await page.$eval('[data-version=V2] [data-action=confirm]', (e) => e.click());
await settle(500);
check('a deleted version is gone', !(await versionNames()).includes('V2'), JSON.stringify(await versionNames()));
check('restoring one kept automatically doesn’t nest its name', (await versionNames())[0] === 'Before going back', JSON.stringify(await versionNames()));

console.log('The whole document as a file');
await page.evaluate(() => window.schmishape.tabs.createTab('part-studio'));
await settle(800);
const before = await tabNames();
await page.evaluate(() => {
  window.__saved = null;
  window.showSaveFilePicker = async ({ suggestedName }) => ({ name: suggestedName, createWritable: async () => ({ write: async (b) => { window.__saved = await b.text(); }, close: async () => {} }) });
});
await menu('save.document');
await settle(400);
const saved = await page.evaluate(() => window.__saved);
const parsed = saved ? JSON.parse(saved) : null;
check('Save the whole document writes one file with every tab', parsed?.format === 'schmishape-document' && Object.keys(parsed.entries).filter((k) => k.startsWith('schmishape.document.')).length >= 2, saved?.slice(0, 120));
await page.evaluate(() => window.schmishape.tabs.deleteTab(window.schmishape.tabs.activeTabId()));
await settle(600);
await page.evaluate(() => window.schmishape.tabs.activateTab(window.schmishape.tabs.tabs().find((t) => t.kind === 'part-studio').id));
await settle(600);
await box('Later', 5);
await settle(300);
await page.evaluate((text) => { window.showOpenFilePicker = async () => [{ name: 'Bracket.schmishape', getFile: async () => new File([text], 'Bracket.schmishape') }]; }, saved);
await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), menu('open.document')]);
await ready();
check('opening it brings every tab back', JSON.stringify(await tabNames()) === JSON.stringify(before), `${JSON.stringify(await tabNames())} vs ${JSON.stringify(before)}`);
await page.evaluate(() => window.schmishape.tabs.activateTab(window.schmishape.tabs.tabs().find((t) => t.kind === 'part-studio').id));
await settle(600);
check('as they were saved', JSON.stringify(await features()) === '["Base","Top"]', JSON.stringify(await features()));
await menu('versions');
check('and the document it replaced is kept as a version', (await versionNames())[0] === 'Before opening Bracket.schmishape', JSON.stringify(await versionNames()));
await page.evaluate((text) => { window.showOpenFilePicker = async () => [{ name: 'Bracket.schmishape', getFile: async () => new File([text], 'Bracket.schmishape') }]; }, saved);
await page.click('[data-testid=file-menu]');
await wait(100);
check('Ctrl O takes a document file too', await page.$eval('[data-command=open]', (e) => !e.disabled));
await page.keyboard.press('Escape');
await page.evaluate(() => { window.showOpenFilePicker = async () => [{ name: 'notes.schmishape', getFile: async () => new File(['{"format": "schmishape-document", "entries": {}}'], 'notes.schmishape') }]; });
await menu('open.document');
await settle(400);
check('a file with no tabs is refused, in words', await page.evaluate(() => document.body.innerText.includes('It has no tabs in it.')));
await shot('versions-file');

check('no console errors', problems.length === 0, problems.join(' | '));
console.log(`\n${passed} passed, ${failures.length} failed`);
await browser.close();
process.exit(failures.length ? 1 : 0);
