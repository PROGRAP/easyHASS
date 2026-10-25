/** Assigned-device move/share choices against the isolated local HA; never sends device services. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { LocalHA } from './ha-client.mjs';
import { localBrowser } from './browser-login.mjs';

const report = { at: new Date().toISOString(), results: [], errors: [], screenshots: [] };
const prefix = `Easy-Hass Test Links ${Date.now()}-${randomUUID().slice(0, 5)}`;
const areas = [], serviceEvents = [];
let ha, browser, page, initial, fixtures, failure;
const stateHash = states => createHash('sha256').update(JSON.stringify(states.map(({ entity_id, state, attributes }) => ({ entity_id, state, attributes })).sort((a, b) => a.entity_id.localeCompare(b.entity_id)))).digest('hex');
const check = async (name, run) => {
  try { await run(); report.results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.results.push({ name, pass: false, error: error.stack || String(error) }); throw error; }
};
await mkdir('test-results', { recursive: true });
try {
  ha = await LocalHA.open();
  const [registryAreas, devices, entities, initialSettings, states] = await Promise.all([
    ha.call('config/area_registry/list'), ha.call('config/device_registry/list'), ha.call('config/entity_registry/list'), ha.call('easy_hass/settings/get'), ha.call('get_states'),
  ]);
  assert.ok(initialSettings.room_device_links && typeof initialSettings.room_device_links === 'object', 'Load the new links backend before modifying fixtures');
  const fixture = suffix => {
    const entity = entities.find(item => item.unique_id === `easy_hass_test_${suffix}`);
    const device = devices.find(item => item.id === entity?.device_id);
    assert.equal(device?.manufacturer, 'Easy-Hass test fixture', 'Never touch a real device');
    assert.equal(entity.area_id ?? null, null, 'Use only known inherited-area fixtures');
    return { entity, device, key: `device:${device.id}` };
  };
  fixtures = { light: fixture('living_light'), cover: fixture('living_cover') };
  assert.notEqual(fixtures.light.device.id, fixtures.cover.device.id);
  const ids = new Set(Object.values(fixtures).map(item => item.entity.entity_id));
  initial = { areas: registryAreas, devices, entities, settings: initialSettings, states: stateHash(states.filter(item => ids.has(item.entity_id))) };
  await ha.call('subscribe_events', { event_type: 'call_service' }, event => serviceEvents.push(event.data));
  for (const suffix of ['A', 'B', 'C']) areas.push(await ha.call('config/area_registry/create', { name: `${prefix} ${suffix}` }));
  const [a, b, c] = areas;
  await ha.call('config/device_registry/update', { device_id: fixtures.light.device.id, area_id: a.area_id });
  await ha.call('config/device_registry/update', { device_id: fixtures.cover.device.id, area_id: null });
  ({ browser, page } = await localBrowser({ reducedMotion: 'reduce', hasTouch: true }));
  page.on('pageerror', error => report.errors.push(error.message));
  const panel = page.locator('easy-hass-panel'), title = panel.locator('#settings-title');
  const rows = panel.locator('[data-settings-device-row]'), current = panel.locator('.room-detail[data-current-room]');
  const row = item => panel.locator(`[data-settings-device-row="${item.key}"]`);
  const assign = item => panel.locator(`[data-settings-device-assign="${item.key}"]`);
  const handle = item => panel.locator(`[data-settings-device-drag="${item.key}"]`);
  const moveChoice = panel.locator('[data-settings-device-mode="move"]');
  const linkChoice = panel.locator('[data-settings-device-mode="additional"]');
  const settings = () => ha.call('easy_hass/settings/get');
  const links = async area => (await settings()).room_device_links[area.area_id] || [];
  const nativeArea = async item => (await ha.call('config/device_registry/list')).find(device => device.id === item.device.id)?.area_id ?? null;
  const listOrder = () => rows.evaluateAll(nodes => nodes.map(node => node.dataset.settingsDeviceRow));
  const wsWrites = () => page.evaluate(() => window.__linksTransport.writes.length);
  const installTransport = () => panel.evaluate(el => {
    const connection = el.hass.connection, originalSend = connection.sendMessagePromise;
    if (typeof originalSend !== 'function') throw new Error('Service transport interception is required');
    const probe = window.__linksTransport = { connection, originalSend, services: [], writes: [], rejectType: null };
    connection.sendMessagePromise = function (message) {
      if (message.type === 'call_service') { probe.services.push(message); return Promise.resolve({}); }
      if (/^(?:config\/(?:area|device|entity)_registry\/(?:update|create|delete|reorder)|easy_hass\/.*\/set)$/.test(message.type)) probe.writes.push(message);
      if (message.type === probe.rejectType) return Promise.reject(new Error('Test: Zusätzliche Anzeige konnte nicht gespeichert werden.'));
      return originalSend.call(this, message);
    };
  });
  const dismiss = async () => {
    for (let n = 0; n < 9 && await panel.getByRole('dialog').count(); n++) {
      const close = current.locator('[data-room-back]');
      if (await close.isVisible() && !await panel.locator('.sheet').count()) { await close.click(); await expect(panel.locator('.room-stage')).toHaveCount(0); }
      else await page.keyboard.press('Escape');
    }
    await expect(panel.getByRole('dialog')).toHaveCount(0);
  };
  const devicesPage = async area => {
    await dismiss(); await panel.locator('[data-tab="more"]').click();
    await panel.locator('[data-settings-page="settings"]').click(); await panel.locator('[data-settings-page="rooms"]').click();
    await panel.locator(`[data-settings-area="${area.area_id}"]`).click(); await panel.locator('[data-settings-page="devices"]').click();
    await expect(title).toHaveText('Geräte');
  };
  const choose = async item => {
    await panel.locator('[data-settings-device-add]').click();
    await panel.locator('#settings-device-search').fill(item.device.name_by_user || item.device.name);
    await assign(item).click();
  };
  const share = async (area, item) => {
    await devicesPage(area); await choose(item); await expect(linkChoice).toBeVisible(); await linkChoice.click();
    await expect(title).toHaveText('Geräte'); await expect(row(item)).toHaveAttribute('data-additional', 'true');
    await expect(row(item)).toContainText('Zusätzlich');
    await expect.poll(() => links(area)).toContain(item.key);
  };
  const detail = async area => {
    await dismiss(); await panel.locator(`[data-open-room="${area.area_id}"]`).click();
    await expect(current).toHaveAttribute('data-room-detail', area.area_id);
  };
  const reload = async () => { await page.reload(); await panel.locator('.room-card').first().waitFor({ timeout: 30000 }); await installTransport(); };
  const screenshot = async name => { const path = `test-results/room-device-links-${name}.png`; await page.screenshot({ path }); report.screenshots.push(path); };
  await installTransport();
  report.revision = await panel.evaluate(el => el.shadowRoot.querySelector('link[rel=stylesheet]').href.match(/builds\/([^/]+)/)?.[1]);

  await check('An assigned device opens an explicit move/share choice; cancellation sends no write', async () => {
    await devicesPage(b); const before = await settings(), writes = await wsWrites();
    await choose(fixtures.light); await expect(moveChoice).toBeVisible(); await expect(linkChoice).toBeVisible();
    await expect(moveChoice).toContainText('Verschieben'); await expect(linkChoice).toContainText('Zusätzlich anzeigen');
    assert.equal(await nativeArea(fixtures.light), a.area_id); assert.deepEqual(await settings(), before); assert.equal(await wsWrites(), writes);
    await screenshot('choice-light'); await panel.locator('[data-settings-choice-cancel]').click();
    await expect(linkChoice).toHaveCount(0); await expect(panel.locator('#settings-device-search')).toHaveValue(fixtures.light.device.name_by_user || fixtures.light.device.name);
    await assign(fixtures.light).click(); await expect(linkChoice).toBeVisible(); await page.keyboard.press('Escape');
    await expect(linkChoice).toHaveCount(0); assert.equal(await wsWrites(), writes); assert.deepEqual(await settings(), before);
  });

  await check('Unassigned devices assign directly; choosing Move changes only the native room', async () => {
    await devicesPage(b); await choose(fixtures.cover);
    await expect(title).toHaveText('Geräte'); await expect(linkChoice).toHaveCount(0); await expect(row(fixtures.cover)).toBeVisible();
    await expect.poll(() => nativeArea(fixtures.cover)).toBe(b.area_id); assert.deepEqual(await links(b), []);
    await choose(fixtures.light); await expect(moveChoice).toBeVisible(); await moveChoice.click();
    await expect(title).toHaveText('Geräte'); await expect.poll(() => nativeArea(fixtures.light)).toBe(b.area_id);
    assert.deepEqual(await links(a), []); assert.deepEqual(await links(b), []); await expect(row(fixtures.light)).toBeVisible();
  });

  await check('Additional display persists in two rooms while the original native room remains unchanged', async () => {
    await share(a, fixtures.light); await share(c, fixtures.light);
    assert.equal(await nativeArea(fixtures.light), b.area_id);
    await reload();
    for (const area of [a, b, c]) {
      await detail(area); await expect(current.locator(`[data-inline-details="${fixtures.light.entity.entity_id}"]`)).toBeVisible();
      await expect(current.locator(`[data-inline-range="${fixtures.light.entity.entity_id}"]`)).toHaveCount(1);
    }
    assert.deepEqual(await links(a), [fixtures.light.key]); assert.deepEqual(await links(c), [fixtures.light.key]); assert.deepEqual(await links(b), []);
  });

  await check('Shared devices retain custom cross-domain order and target the same entity from both rooms', async () => {
    await share(a, fixtures.cover);
    const desired = [fixtures.cover.key, fixtures.light.key];
    await handle(fixtures.cover).focus(); await page.keyboard.press('Space'); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
    await expect.poll(listOrder).toEqual(desired);
    await expect.poll(async () => (await settings()).room_device_order[a.area_id]).toEqual(desired);
    await expect(panel.locator('[data-settings-device-add]')).toBeEnabled();
    await screenshot('shared-list');
    await reload(); await detail(a);
    assert.deepEqual(await current.locator('[data-entity-row]').evaluateAll(nodes => nodes.map(node => node.dataset.entityRow)), [fixtures.cover.entity.entity_id, fixtures.light.entity.entity_id]);
    for (const [area, fraction] of [[a, .72], [b, .38]]) {
      await detail(area);
      const range = current.locator(`[data-inline-range="${fixtures.light.entity.entity_id}"]`); await range.scrollIntoViewIfNeeded();
      const box = await range.boundingBox(), before = await page.evaluate(() => window.__linksTransport.services.length);
      await page.mouse.move(box.x + box.width * .5, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width * fraction, box.y + box.height / 2, { steps: 5 });
      const value = Number(await range.inputValue()); assert.ok(Math.abs(value - fraction * 100) <= 1);
      assert.equal(await page.evaluate(() => window.__linksTransport.services.length), before);
      await page.mouse.up(); await expect.poll(() => page.evaluate(() => window.__linksTransport.services.length)).toBe(before + 1);
      const sent = await page.evaluate(() => window.__linksTransport.services.at(-1));
      assert.equal(sent.domain, 'light'); assert.equal(sent.service, 'turn_on');
      assert.deepEqual(sent.target?.entity_id || sent.service_data.entity_id, [fixtures.light.entity.entity_id]); assert.equal(sent.service_data.brightness_pct, value);
    }
  });

  await check('Removing one additional display preserves native assignment, the other shared room and unrelated links', async () => {
    await devicesPage(a); await panel.locator(`[data-settings-device-remove="${fixtures.light.key}"]`).click();
    await expect(row(fixtures.light)).toHaveCount(0); await expect(row(fixtures.cover)).toBeVisible();
    await expect.poll(() => links(a)).toEqual([fixtures.cover.key]); assert.deepEqual(await links(c), [fixtures.light.key]); assert.equal(await nativeArea(fixtures.light), b.area_id);
    await reload();
    await detail(a); await expect(current.locator(`[data-entity-row="${fixtures.light.entity.entity_id}"]`)).toHaveCount(0);
    for (const area of [b, c]) { await detail(area); await expect(current.locator(`[data-inline-details="${fixtures.light.entity.entity_id}"]`)).toBeVisible(); }
  });

  await check('Failed additional display keeps assignments and links intact and reports the save error', async () => {
    await devicesPage(a); await choose(fixtures.light); await expect(linkChoice).toBeVisible();
    const before = await settings();
    await page.evaluate(() => { window.__linksTransport.rejectType = 'easy_hass/room_device_link/set'; });
    try {
      await linkChoice.click(); await expect(panel.locator('.sheet [role="alert"]')).toContainText('nicht gespeichert');
      assert.deepEqual(await settings(), before); assert.equal(await nativeArea(fixtures.light), b.area_id);
    } finally { await page.evaluate(() => { window.__linksTransport.rejectType = null; }); }
  });

  await check('Offline and non-admin states disable assignment choices without emitting writes', async () => {
    await devicesPage(a); await choose(fixtures.light); await expect(linkChoice).toBeVisible();
    const before = await settings(), writes = await wsWrites();
    for (const mode of ['offline', 'nonadmin']) {
      await panel.evaluate((el, mode) => {
        window.__linksOriginalHass = el.hass;
        el.hass = mode === 'offline' ? { ...el.hass, connected: false } : { ...el.hass, user: { ...el.hass.user, is_admin: false } };
      }, mode);
      try { await expect(moveChoice).toBeDisabled(); await expect(linkChoice).toBeDisabled(); assert.equal(await wsWrites(), writes); }
      finally { await panel.evaluate(el => { el.hass = window.__linksOriginalHass; delete window.__linksOriginalHass; }); }
      await expect(linkChoice).toBeEnabled();
    }
    assert.deepEqual(await settings(), before);
    await panel.evaluate(el => { localStorage.setItem(el._themeKey(), 'dark'); el._applyTheme(); });
    await page.setViewportSize({ width: 320, height: 700 }); await screenshot('choice-narrow-dark');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });
  assert.deepEqual(serviceEvents, []); report.haServiceCalls = serviceEvents.length; assert.deepEqual(report.errors, []);
} catch (error) {
  failure = error; if (page) await page.screenshot({ path: 'test-results/room-device-links-failure.png' }).catch(() => {});
} finally {
  const cleanup = async run => { try { await run(); } catch (error) { report.errors.push(`Cleanup: ${error.message}`); } };
  if (page) { await cleanup(() => page.keyboard.press('Escape')); await cleanup(() => page.mouse.up()); }
  if (browser) await cleanup(() => browser.close());
  if (ha && fixtures) for (const item of Object.values(fixtures)) await cleanup(() => ha.call('config/device_registry/update', { device_id: item.device.id, area_id: item.device.area_id ?? null }));
  if (ha) for (const area of areas) {
    if (fixtures) for (const item of Object.values(fixtures)) await cleanup(() => ha.call('easy_hass/room_device_link/set', { area_id: area.area_id, key: item.key, linked: false }));
    await cleanup(() => ha.call('easy_hass/room_device_order/set', { area_id: area.area_id, keys: [] }));
    await cleanup(async () => {
      const actual = (await ha.call('config/area_registry/list')).find(item => item.area_id === area.area_id);
      assert.equal(actual?.name, area.name); assert.ok(area.name.startsWith(prefix));
      await ha.call('config/area_registry/delete', { area_id: area.area_id });
    });
  }
  if (ha && initial) await cleanup(async () => {
    const [areas, devices, entities, settings, states] = await Promise.all([
      ha.call('config/area_registry/list'), ha.call('config/device_registry/list'), ha.call('config/entity_registry/list'), ha.call('easy_hass/settings/get'), ha.call('get_states'),
    ]);
    assert.deepEqual(areas.map(item => [item.area_id, item.name, item.picture]), initial.areas.map(item => [item.area_id, item.name, item.picture]));
    assert.deepEqual(devices.map(item => [item.id, item.area_id]), initial.devices.map(item => [item.id, item.area_id]));
    assert.deepEqual(entities.map(item => [item.entity_id, item.area_id]), initial.entities.map(item => [item.entity_id, item.area_id]));
    assert.deepEqual(settings, initial.settings);
    const ids = new Set(Object.values(fixtures).map(item => item.entity.entity_id));
    assert.equal(stateHash(states.filter(item => ids.has(item.entity_id))), initial.states); assert.deepEqual(serviceEvents, []);
    report.cleanup = 'All native assignments, additional displays, custom orders, areas and fixture states restored';
  });
  ha?.close(); await writeFile('test-results/browser-room-device-links.json', `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.results.filter(item => item.pass).length, report: 'test-results/browser-room-device-links.json' }));
if (failure) throw failure;
if (report.errors.length) throw new Error('Device-link checks reported browser or cleanup errors');
