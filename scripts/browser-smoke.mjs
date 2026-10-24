/** End-to-end checks through the real HA frontend, not a mock hass object. */
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { localBrowser } from './browser-login.mjs';
import { LocalHA, baseUrl } from './ha-client.mjs';

const ha = await LocalHA.open();
const { browser, context, page } = await localBrowser({ hasTouch: true });
const results = [], errors = [];
let newArea;
let movedEntity;
const initial = new Map((await ha.call('get_states')).map(state => [state.entity_id, state]));
const registry = await ha.call('config/entity_registry/list');
const entity = suffix => registry.find(item => item.unique_id === `easy_hass_test_${suffix}`);
const living = entity('living_light'), onoff = entity('living_onoff'), cover = entity('living_cover'), vacuum = entity('hall_vacuum');
const rooms = await ha.call('config/area_registry/list');
const livingArea = rooms.find(area => area.name === 'Wohnzimmer');
const card = id => page.locator(`[data-room-card="${id}"]`);
const control = (kind, id = livingArea.area_id) => card(id).locator(`[data-control="${kind}"]`);
const getState = async id => (await ha.call('get_states')).find(state => state.entity_id === id);
const service = (domain, name, ids, data = {}) => ha.call('call_service', { domain, service: name, target: { entity_id: ids }, service_data: data });
const check = async (name, fn) => {
  await fn(); results.push({ name, pass: true }); console.log(`PASS ${name}`);
};
const settle = async () => expect(page.locator('.room-card')).toHaveCount(rooms.length);
const point = async locator => { await locator.scrollIntoViewIfNeeded(); const r = await locator.boundingBox(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
async function hold(kind, id = livingArea.area_id) {
  const p = await point(control(kind, id));
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await expect(page.locator('.adjust-bar')).toBeVisible({ timeout: 1500 });
  return p;
}
page.on('pageerror', error => errors.push(error.message));
await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });

try {
  await check('HA registries supply all room names and photos', async () => {
    await settle();
    assert.deepEqual(new Set(await page.locator('.room-card h2').allTextContents()), new Set(rooms.map(room => room.name)));
    assert.equal(await page.locator('[data-room-picture]').count(), rooms.filter(room => room.picture).length);
    await expect.poll(() => page.locator('[data-room-picture]').evaluateAll(images => images.every(img => img.complete && img.naturalWidth > 0))).toBe(true);
  });
  await check('Mobile FigCraft sizing, local Inter font and no horizontal overflow', async () => {
    const r = await card(livingArea.area_id).boundingBox();
    assert.equal(r.width, 173); assert.equal(r.height, 180);
    assert.equal(await page.evaluate(() => document.fonts.check('17px EasyHassInter')), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: 'test-results/rooms-light.png', fullPage: true });
  });
  await check('Short tap toggles every actual room light once', async () => {
    await service('light', 'turn_off', [living.entity_id, onoff.entity_id]);
    await expect(control('light')).toHaveAttribute('aria-pressed', 'false');
    await control('light').click();
    await expect.poll(async () => (await getState(living.entity_id)).state).toBe('on');
    await expect.poll(async () => (await getState(onoff.entity_id)).state).toBe('on');
    await expect(control('light')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.adjust-bar')).toHaveCount(0);
  });
  await check('External HA changes appear without reloading the page', async () => {
    await service('light', 'turn_off', [living.entity_id, onoff.entity_id]);
    await expect(control('light')).toHaveAttribute('aria-pressed', 'false');
    await service('light', 'turn_on', living.entity_id, { brightness_pct: 70 });
    await expect(control('light')).toHaveAttribute('aria-pressed', 'true');
  });
  await check('Hold opens a sharp yellow control with 32px background blur; no movement changes nothing', async () => {
    const before = await getState(living.entity_id);
    await hold('light');
    await expect(page.locator('#adjust-value')).toHaveText('70 %');
    assert.equal(await page.locator('.adjust-backdrop').evaluate(el => getComputedStyle(el).backdropFilter), 'blur(32px)');
    assert.equal(await page.locator('.adjust-bar').evaluate(el => getComputedStyle(el).filter), 'none');
    await page.screenshot({ path: 'test-results/light-overlay-light.png' });
    await page.mouse.up();
    await expect(page.locator('.adjust-bar')).toHaveCount(0);
    assert.equal((await getState(living.entity_id)).last_updated, before.last_updated);
  });
  await check('Mouse hold and drag dim only capable lights, then close and confirm HA value', async () => {
    const p = await hold('light');
    await page.mouse.move(p.x - 65, p.y, { steps: 6 });
    const expected = Number((await page.locator('#adjust-value').textContent()).replace(/\D/g, ''));
    assert.ok(expected > 0 && expected < 70);
    await page.mouse.up();
    await expect(page.locator('.adjust-bar')).toHaveCount(0);
    await expect.poll(async () => Math.round((await getState(living.entity_id)).attributes.brightness / 255 * 100)).toBe(expected);
    assert.equal((await getState(onoff.entity_id)).state, 'off');
  });
  await check('Dragging to both boundaries reaches actual HA 0 and 100 percent', async () => {
    for (const [x, value] of [[16, 0], [374, 100]]) {
      const p = await hold('light');
      await page.mouse.move(x, p.y, { steps: 8 });
      await expect(page.locator('#adjust-value')).toHaveText(`${value} %`);
      await page.mouse.up();
      await expect.poll(async () => { const state = await getState(living.entity_id); return state.state === 'off' ? 0 : Math.round(state.attributes.brightness / 255 * 100); }).toBe(value);
    }
  });
  await check('Escape cancels an in-progress gesture without sending its draft', async () => {
    const before = await getState(living.entity_id);
    const p = await hold('light'); await page.mouse.move(40, p.y);
    await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(page.locator('.adjust-bar')).toHaveCount(0);
    assert.equal((await getState(living.entity_id)).last_updated, before.last_updated);
  });
  await check('Cover tap really closes and reopens; its icon changes with position', async () => {
    await service('cover', 'set_cover_position', cover.entity_id, { position: 100 });
    await expect(control('cover')).toHaveAttribute('aria-label', /, 100 Prozent/);
    const openIcon = await control('cover').innerHTML();
    await control('cover').click();
    await expect.poll(async () => (await getState(cover.entity_id)).attributes.current_position).toBe(0);
    await expect(control('cover')).toHaveAttribute('aria-label', /, 0 Prozent/);
    assert.notEqual(await control('cover').innerHTML(), openIcon);
    await control('cover').click();
    await expect.poll(async () => (await getState(cover.entity_id)).attributes.current_position).toBe(100);
  });
  await check('Lilac cover hold/drag commits the displayed position to HA', async () => {
    const p = await hold('cover'); await page.mouse.move(p.x - 60, p.y, { steps: 6 });
    const expected = Number((await page.locator('#adjust-value').textContent()).replace(/\D/g, ''));
    assert.ok(expected > 0 && expected < 100);
    await page.screenshot({ path: 'test-results/blind-overlay-light.png' });
    await page.mouse.up();
    await expect.poll(async () => (await getState(cover.entity_id)).attributes.current_position).toBe(expected);
  });
  await check('Native touch hold and horizontal move adjust the real light', async () => {
    await service('light', 'turn_on', living.entity_id, { brightness_pct: 50 });
    await expect(control('light')).toHaveAttribute('aria-pressed', 'true');
    const p = await point(control('light')); const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
    await expect(page.locator('.adjust-bar')).toBeVisible({ timeout: 1500 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x + 80, y: p.y }] });
    const expected = Number((await page.locator('#adjust-value').textContent()).replace(/\D/g, ''));
    assert.ok(expected > 50);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('.adjust-bar')).toHaveCount(0);
    await expect.poll(async () => Math.round((await getState(living.entity_id)).attributes.brightness / 255 * 100)).toBe(expected);
    await cdp.detach();
  });
  await check('Keyboard adjustment traps focus, cancels with Enter on Cancel, and commits with Enter on slider', async () => {
    const before = await getState(living.entity_id);
    await control('light').focus(); await page.keyboard.press('ArrowRight');
    await expect(page.locator('#adjust-range')).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-dismiss]').filter({ hasText: 'Abbrechen' })).toBeFocused();
    await page.keyboard.press('Enter');
    assert.equal((await getState(living.entity_id)).last_updated, before.last_updated);
    await control('light').focus(); await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Home'); await page.keyboard.press('Enter');
    await expect.poll(async () => (await getState(living.entity_id)).state).toBe('off');
  });
  await check('New/renamed/deleted HA areas and reassigned on-off devices change the UI live', async () => {
    newArea = await ha.call('config/area_registry/create', { name: 'Büro & Gäste · dynamisch' });
    await expect(card(newArea.area_id).locator('h2')).toHaveText('Büro & Gäste · dynamisch');
    movedEntity = onoff;
    await ha.call('config/entity_registry/update', { entity_id: onoff.entity_id, area_id: newArea.area_id });
    await expect(control('light', newArea.area_id)).toBeVisible();
    const p = await point(control('light', newArea.area_id));
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.waitForTimeout(500);
    await expect(page.locator('.adjust-bar')).toHaveCount(0); await page.mouse.up();
    await ha.call('config/area_registry/update', { area_id: newArea.area_id, name: 'Ein anderer Raum' });
    await expect(card(newArea.area_id).locator('h2')).toHaveText('Ein anderer Raum');
    await ha.call('config/entity_registry/update', { entity_id: onoff.entity_id, area_id: onoff.area_id ?? null }); movedEntity = null;
    await ha.call('config/area_registry/delete', { area_id: newArea.area_id }); newArea = null;
    await settle();
  });
  await check('Unavailable devices disable real controls; restoring HA state recovers them', async () => {
    const saved = await getState(cover.entity_id);
    await ha.api(`/api/states/${cover.entity_id}`, { state: 'unavailable', attributes: saved.attributes });
    await expect(control('cover')).toBeDisabled();
    await service('cover', 'set_cover_position', cover.entity_id, { position: 70 });
    await expect(control('cover')).toBeEnabled();
  });
  await check('Dark theme persists and both overlays retain the dark design and blur', async () => {
    await page.locator('[data-tab="more"]').click();
    await page.locator('.appearance label').filter({ hasText: 'Dunkel' }).click();
    await page.getByRole('button', { name: 'Schließen', exact: true }).click();
    await expect(page.locator('easy-hass-panel')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: 'test-results/rooms-dark.png', fullPage: true });
    for (const kind of ['light', 'cover']) {
      await hold(kind);
      assert.equal(await page.locator('.adjust-backdrop').evaluate(el => getComputedStyle(el).backdropFilter), 'blur(32px)');
      await page.screenshot({ path: `test-results/${kind}-overlay-dark.png` });
      await page.mouse.up();
    }
    await page.reload(); await settle();
    await expect(page.locator('easy-hass-panel')).toHaveAttribute('data-theme', 'dark');
  });
  await check('Vacuum menu starts and returns the real HA vacuum', async () => {
    await page.locator('[data-tab="robot"]').click();
    await page.locator(`[data-vacuum="${vacuum.entity_id}"][data-action="start"]`).click();
    await expect.poll(async () => (await getState(vacuum.entity_id)).state).toBe('cleaning');
    await expect(page.locator('.robot-card p')).toContainText('Reinigt');
    await page.locator(`[data-vacuum="${vacuum.entity_id}"][data-action="return_to_base"]`).click();
    await expect.poll(async () => (await getState(vacuum.entity_id)).state).toBe('docked');
    await page.locator('[data-tab="home"]').click();
  });
  await check('Desktop grid is responsive and leaves no hidden sidebar margin', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(() => page.locator('.room-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(4);
    assert.equal(await page.locator('easy-hass-panel').evaluate(el => el.getBoundingClientRect().x), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: 'test-results/rooms-desktop.png', fullPage: true });
  });
  await check('More opens the actual HA expert view with its navigation restored', async () => {
    await page.locator('[data-tab="more"]').click();
    await page.locator('.sheet a').filter({ hasText: 'Expertenansicht' }).click();
    await expect(page).toHaveURL(url => url.origin === baseUrl && /^\/config(?:\/dashboard)?$/.test(url.pathname));
    await expect(page.locator('ha-sidebar')).toBeVisible();
  });
  await check('No uncaught Easy-Hass browser errors', async () => assert.deepEqual(errors.filter(error => /easy.hass/i.test(error)), []));
} finally {
  await page.mouse.up().catch(() => {});
  if (movedEntity) await ha.call('config/entity_registry/update', { entity_id: movedEntity.entity_id, area_id: movedEntity.area_id ?? null });
  if (newArea) await ha.call('config/area_registry/delete', { area_id: newArea.area_id });
  for (const light of [living, onoff]) {
    const state = initial.get(light.entity_id);
    await service('light', state.state === 'on' ? 'turn_on' : 'turn_off', light.entity_id, state.state === 'on' && state.attributes.brightness ? { brightness: state.attributes.brightness } : {});
  }
  await service('cover', 'set_cover_position', cover.entity_id, { position: initial.get(cover.entity_id).attributes.current_position });
  await service('vacuum', 'return_to_base', vacuum.entity_id);
  await browser.close(); ha.close();
  await writeFile(new URL('../test-results/browser-smoke.json', import.meta.url), `${JSON.stringify({ at: new Date().toISOString(), results, errors }, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: results.length, report: 'test-results/browser-smoke.json' }));
