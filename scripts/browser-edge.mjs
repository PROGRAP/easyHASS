/** Targeted regressions for unknown readings, gesture edges, failure and reconnect. */
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalHA, baseUrl } from './ha-client.mjs';

let ha = await LocalHA.open();
const run = promisify(execFile);
let serverStopped = false;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 852 }, hasTouch: true, storageState: '.local-ha/browser-state.json' });
const page = await context.newPage();
const results = [];
const entries = await ha.call('config/entity_registry/list');
const find = suffix => entries.find(e => e.unique_id === `easy_hass_test_${suffix}`);
const living = find('living_light'), onoff = find('living_onoff'), kitchen = find('kitchen_light'), cover = find('living_cover');
const states = await ha.call('get_states');
const initial = new Map(states.map(e => [e.entity_id, e]));
const service = (domain, name, entityId, data = {}) => ha.call('call_service', { domain, service: name, target: { entity_id: entityId }, service_data: data });
const state = async id => (await ha.call('get_states')).find(e => e.entity_id === id);
const check = async (name, run) => { await run(); results.push({ name, pass: true }); console.log(`PASS ${name}`); };
const area = name => page.locator('.room-card').filter({ has: page.locator('h2', { hasText: name }) });
const control = (kind, name = 'Wohnzimmer') => area(name).locator(`[data-control="${kind}"]`);
async function hold(kind, name = 'Wohnzimmer') {
  const button = control(kind, name); await button.scrollIntoViewIfNeeded(); const r = await button.boundingBox();
  const p = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  await expect(page.locator('.adjust-bar')).toBeVisible({ timeout: 1500 }); return p;
}
try {
  await page.goto(`${baseUrl}/easy-hass`);
  await expect(page.locator('.room-card')).toHaveCount(5, { timeout: 30000 });
  await page.locator('#ha-launch-screen').waitFor({ state: 'detached', timeout: 10000 });
  await expect.poll(() => page.evaluate(() => [...document.fonts].some(font => font.family === 'EasyHassInter' && font.status === 'loaded'))).toBe(true);
  await expect.poll(() => control('light').evaluate(el => getComputedStyle(el).touchAction)).toBe('none');
  await check('Right-column dimmer reaches 100% within the visible right edge', async () => {
    await service('light', 'turn_on', kitchen.entity_id, { brightness_pct: 10 });
    await expect(control('light', 'Küche')).toHaveAttribute('aria-pressed', 'true');
    const p = await hold('light', 'Küche');
    await page.mouse.move(374, p.y, { steps: 5 });
    await expect(page.locator('#adjust-value')).toHaveText('100 %'); await page.mouse.up();
    await expect.poll(async () => (await state(kitchen.entity_id)).attributes.brightness).toBe(255);
  });
  await check('Unknown light brightness stays unknown; hold/release never switches it off', async () => {
    await service('light', 'turn_off', onoff.entity_id);
    await service('light', 'turn_on', living.entity_id, { brightness_pct: 55 });
    const s = await state(living.entity_id); const attrs = { ...s.attributes }; delete attrs.brightness;
    await ha.api(`/api/states/${living.entity_id}`, { state: 'on', attributes: attrs });
    await expect.poll(() => page.locator('easy-hass-panel').evaluate((el, id) => el.hass.states[id].attributes.brightness ?? null, living.entity_id)).toBe(null);
    const before = await state(living.entity_id); await hold('light');
    await expect(page.locator('#adjust-value')).toHaveText('— %'); await page.mouse.up();
    assert.equal((await state(living.entity_id)).last_updated, before.last_updated);
    await service('light', 'turn_on', living.entity_id, { brightness_pct: 55 });
  });
  await check('Unknown cover position does not invent or apply an open position', async () => {
    const s = await state(cover.entity_id); const attrs = { ...s.attributes }; delete attrs.current_position;
    await ha.api(`/api/states/${cover.entity_id}`, { state: 'open', attributes: attrs });
    await expect.poll(() => page.locator('easy-hass-panel').evaluate((el, id) => el.hass.states[id].attributes.current_position ?? null, cover.entity_id)).toBe(null);
    const before = await state(cover.entity_id); await hold('cover');
    await expect(page.locator('#adjust-value')).toHaveText('— %'); await page.mouse.up();
    assert.equal((await state(cover.entity_id)).last_updated, before.last_updated);
    await service('cover', 'set_cover_position', cover.entity_id, { position: 60 });
  });
  await check('Device becoming unavailable during drag shows an error and never confirms the draft', async () => {
    const p = await hold('cover'); await page.mouse.move(p.x - 50, p.y);
    const s = await state(cover.entity_id);
    await ha.api(`/api/states/${cover.entity_id}`, { state: 'unavailable', attributes: s.attributes });
    await expect.poll(() => page.locator('easy-hass-panel').evaluate((el, id) => el.hass.states[id].state, cover.entity_id)).toBe('unavailable');
    await page.mouse.up();
    await expect(page.locator('#toast')).toBeVisible();
    await expect(control('cover')).toBeDisabled();
    assert.equal((await state(cover.entity_id)).state, 'unavailable');
    await service('cover', 'set_cover_position', cover.entity_id, { position: 60 });
    await expect(control('cover')).toBeEnabled();
  });
  await check('Native touch cancellation discards a changed draft', async () => {
    const before = await state(living.entity_id);
    const button = control('light'); await button.scrollIntoViewIfNeeded(); const r = await button.boundingBox();
    const cdp = await context.newCDPSession(page); const p = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
    await expect(page.locator('.adjust-bar')).toBeVisible({ timeout: 1500 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x + 50, y: p.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await expect(page.locator('.adjust-bar')).toHaveCount(0);
    assert.equal((await state(living.entity_id)).last_updated, before.last_updated); await cdp.detach();
  });
  await check('Offline connection disables controls and reconnects to current HA states', async () => {
    // Chromium's network emulation does not sever an existing WebSocket. Stop the
    // isolated, ownership-checked test runtime to exercise a real disconnection.
    await run('python3', ['scripts/ha-local.py', 'stop']);
    serverStopped = true;
    await expect(page.locator('.status-banner')).toContainText('Verbindung unterbrochen', { timeout: 15000 });
    await expect(control('light')).toBeDisabled();
    await run('python3', ['scripts/ha-local.py', 'start']);
    serverStopped = false;
    ha.close(); ha = await LocalHA.open();
    await expect(control('light')).toBeEnabled({ timeout: 20000 });
    await expect(control('light')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.status-banner')).toHaveCount(0);
  });
} finally {
  if (serverStopped) { await run('python3', ['scripts/ha-local.py', 'start']); ha.close(); ha = await LocalHA.open(); }
  await page.mouse.up().catch(() => {});
  for (const e of [living, onoff, kitchen]) {
    const s = initial.get(e.entity_id); await service('light', s.state === 'on' ? 'turn_on' : 'turn_off', e.entity_id, s.state === 'on' && s.attributes.brightness ? { brightness: s.attributes.brightness } : {});
  }
  await service('cover', 'set_cover_position', cover.entity_id, { position: initial.get(cover.entity_id).attributes.current_position });
  await browser.close(); ha.close();
  await writeFile('test-results/browser-edge.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
}
console.log(JSON.stringify({ passed: results.length }));
