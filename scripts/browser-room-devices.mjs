/** Real local HA device assignment/order, with exact cleanup; gesture services stay browser-only. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { LocalHA } from './ha-client.mjs';
import { localBrowser } from './browser-login.mjs';

const report = { at: new Date().toISOString(), results: [], errors: [], screenshots: [] };
const name = `Easy-Hass Test Geräte ${Date.now()}-${randomUUID().slice(0, 6)}`, draftName = `${name} Entwurf`;
let ha, browser, context, page, cdp, area, initialAreas, initialDevices, initialEntities, initialSettings, initialStates, fixtures, appearance, failure;
let activeTouch = false;
const actualServices = [], settingsEvents = [];
const sorted = (rows, key) => [...rows].sort((a, b) => a[key].localeCompare(b[key]));
const stateHash = states => createHash('sha256').update(JSON.stringify(sorted(states.map(({ entity_id, state, attributes }) => ({ entity_id, state, attributes })), 'entity_id'))).digest('hex');
const moved = (order, from, to) => { const next = [...order], [key] = next.splice(from, 1); next.splice(to, 0, key); return next; };
const check = async (label, run) => {
  try { await run(); report.results.push({ name: label, pass: true }); console.log(`PASS ${label}`); }
  catch (error) { report.results.push({ name: label, pass: false, error: error.stack || String(error) }); throw error; }
};
await mkdir('test-results', { recursive: true });
try {
  ha = await LocalHA.open();
  [initialAreas, initialDevices, initialEntities, initialSettings] = await Promise.all([
    ha.call('config/area_registry/list'), ha.call('config/device_registry/list'), ha.call('config/entity_registry/list'), ha.call('easy_hass/settings/get'),
  ]);
  assert.ok(initialSettings.room_device_order && typeof initialSettings.room_device_order === 'object', 'New room-order backend must be loaded before fixture writes');
  const fixture = suffix => {
    const entity = initialEntities.find(item => item.unique_id === `easy_hass_test_${suffix}`);
    assert.ok(entity?.device_id, `Missing isolated physical fixture ${suffix}`);
    const device = initialDevices.find(item => item.id === entity.device_id);
    assert.equal(device?.manufacturer, 'Easy-Hass test fixture', 'Never move a real user device');
    assert.equal(entity.area_id ?? null, null, 'These fixtures inherit native device areas; explicit overrides must remain untouched');
    return { entity, device, key: `device:${device.id}` };
  };
  fixtures = { light: fixture('living_light'), binary: fixture('living_onoff'), cover: fixture('living_cover'), temperature: fixture('living_temperature') };
  const selected = Object.values(fixtures), selectedIds = new Set(selected.map(item => item.entity.entity_id));
  assert.equal(new Set(selected.map(item => item.device.id)).size, selected.length);
  initialStates = stateHash((await ha.call('get_states')).filter(item => selectedIds.has(item.entity_id)));
  await ha.call('subscribe_events', { event_type: 'call_service' }, event => actualServices.push(event.data));
  await ha.call('easy_hass/settings/subscribe', {}, snapshot => settingsEvents.push(snapshot));
  const picture = initialAreas.find(item => item.area_id === fixtures.light.device.area_id)?.picture;
  area = await ha.call('config/area_registry/create', { name, ...(picture ? { picture } : {}) });
  assert.ok(area.area_id && !initialAreas.some(item => item.area_id === area.area_id));
  ({ browser, context, page } = await localBrowser({ reducedMotion: 'reduce', hasTouch: true }));
  cdp = await context.newCDPSession(page);
  page.on('pageerror', error => report.errors.push(error.message));
  const panel = page.locator('easy-hass-panel'), title = panel.locator('#settings-title');
  const more = panel.locator('[data-tab="more"]'), back = panel.locator('[data-settings-back]');
  const add = panel.locator('[data-settings-device-add]'), search = panel.locator('#settings-device-search');
  const rows = panel.locator('[data-settings-device-row]');
  const row = key => panel.locator(`[data-settings-device-row="${key}"]`);
  const handle = key => panel.locator(`[data-settings-device-drag="${key}"]`);
  const assign = key => panel.locator(`[data-settings-device-assign="${key}"]`);
  const remove = key => panel.locator(`[data-settings-device-remove="${key}"]`);
  const currentRoom = panel.locator('.room-detail[data-current-room]');
  const listOrder = () => rows.evaluateAll(nodes => nodes.map(node => node.dataset.settingsDeviceRow));
  const visualOrder = () => rows.evaluateAll(nodes => nodes.map(node => ({ key: node.dataset.settingsDeviceRow, y: node.getBoundingClientRect().top })).sort((a, b) => a.y - b.y).map(item => item.key));
  const savedOrder = async () => (await ha.call('easy_hass/settings/get')).room_device_order[area.area_id] || [];
  const ownArea = async () => (await ha.call('config/area_registry/list')).find(item => item.area_id === area.area_id);
  const deviceArea = async id => (await ha.call('config/device_registry/list')).find(item => item.id === id)?.area_id ?? null;
  const dismiss = async () => {
    for (let n = 0; n < 9 && await panel.getByRole('dialog').count(); n++) {
      const roomClose = currentRoom.locator('[data-room-back]');
      if (await roomClose.isVisible() && !await panel.locator('.sheet').count()) {
        await roomClose.click(); await expect(panel.locator('.room-stage')).toHaveCount(0);
      } else await page.keyboard.press('Escape');
    }
    await expect(panel.getByRole('dialog')).toHaveCount(0);
  };
  const editor = async () => {
    await dismiss(); await more.click(); await panel.locator('[data-settings-page="settings"]').click();
    await panel.locator('[data-settings-page="rooms"]').click(); await panel.locator(`[data-settings-area="${area.area_id}"]`).click();
    await expect(panel.locator('#settings-room-name')).toBeVisible();
  };
  const openDevices = async () => { await editor(); await panel.locator('[data-settings-page="devices"]').click(); await expect(title).toHaveText('Geräte'); };
  const openDetail = async () => { await dismiss(); await panel.locator(`[data-open-room="${area.area_id}"]`).click(); await expect(currentRoom).toHaveAttribute('data-room-detail', area.area_id); };
  const assertOrder = async expected => { await expect.poll(savedOrder).toEqual(expected); await expect.poll(listOrder).toEqual(expected); await expect.poll(visualOrder).toEqual(expected); };
  const screenshot = async suffix => { const path = `test-results/room-devices-${suffix}.png`; await page.screenshot({ path }); report.screenshots.push(path); };
  const touch = async (type, x, y) => {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: ['touchEnd', 'touchCancel'].includes(type) ? [] : [{ x, y }] });
    activeTouch = !['touchEnd', 'touchCancel'].includes(type);
  };
  const moveRow = async (from, to, mode = 'mouse') => {
    await handle(from).scrollIntoViewIfNeeded();
    const a = await handle(from).boundingBox(), b = await row(to).boundingBox();
    const x = a.x + a.width / 2, y = a.y + a.height / 2, end = b.y + b.height * (b.y > y ? .8 : .2);
    if (mode === 'mouse') { await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, end, { steps: 10 }); }
    else { await touch('touchStart', x, y); for (let n = 1; n <= 10; n++) await touch('touchMove', x, y + (end - y) * n / 10); }
  };
  const drop = mode => mode === 'touch' ? touch('touchEnd') : page.mouse.up();
  appearance = await panel.evaluate(el => ({ key: el._themeKey(), value: localStorage.getItem(el._themeKey()) }));
  await panel.evaluate(el => { localStorage.setItem(el._themeKey(), 'light'); el._applyTheme(); });
  const narrowScreens = async prefix => {
    await page.setViewportSize({ width: 320, height: 700 });
    for (const theme of ['light', 'dark']) {
      await panel.evaluate((el, theme) => { localStorage.setItem(el._themeKey(), theme); el._applyTheme(); }, theme);
      await expect(panel).toHaveAttribute('data-theme', theme);
      await screenshot(`${prefix}-narrow-${theme}`);
    }
    await page.setViewportSize({ width: 390, height: 852 });
    await panel.evaluate(el => { localStorage.setItem(el._themeKey(), 'light'); el._applyTheme(); });
  };
  report.revision = await panel.evaluate(el => el.shadowRoot.querySelector('link[rel=stylesheet]').href.match(/builds\/([^/]+)/)?.[1]);

  await check('Device subpages preserve the room draft; the searchable picker exposes real devices without sensor entity duplicates', async () => {
    await editor(); await panel.locator('#settings-room-name').fill(draftName);
    await panel.locator('[data-settings-page="devices"]').click(); await expect(rows).toHaveCount(0);
    await expect(panel.locator('.settings-device-empty')).toContainText('noch keine Geräte');
    await add.click(); await expect(search).toBeFocused();
    for (const item of selected) await expect(assign(item.key)).toBeVisible();
    await expect(assign(`entity:${fixtures.temperature.entity.entity_id}`)).toHaveCount(0);
    await search.fill('Wohnzimmer'); await narrowScreens('picker');
    await search.fill(name); await expect(panel.locator('[data-settings-device-assign]')).toHaveCount(0);
    await search.fill(fixtures.light.device.name); await expect(assign(fixtures.light.key)).toBeVisible();
    await back.click(); await expect(title).toHaveText('Geräte'); await back.click();
    await expect(panel.locator('#settings-room-name')).toHaveValue(draftName);
    assert.equal((await ownArea()).name, name, 'Assignment navigation does not save an unrelated name draft');
    for (const item of selected) assert.equal(await deviceArea(item.device.id), item.device.area_id ?? null);
  });

  await check('Adding devices writes native HA area assignments and preserves all entity overrides', async () => {
    await panel.locator('[data-settings-page="devices"]').click();
    for (const item of selected) {
      await add.click(); await search.fill(item.device.name_by_user || item.device.name);
      await assign(item.key).click();
      await panel.locator('[data-settings-device-mode="move"]').click();
      await expect(title).toHaveText('Geräte');
      await expect.poll(() => deviceArea(item.device.id)).toBe(area.area_id);
      await expect(row(item.key)).toBeVisible();
    }
    assert.deepEqual((await listOrder()).sort(), selected.map(item => item.key).sort());
    const currentEntities = await ha.call('config/entity_registry/list');
    for (const entity of initialEntities.filter(item => selected.some(fixture => fixture.device.id === item.device_id))) {
      assert.equal(currentEntities.find(item => item.entity_id === entity.entity_id)?.area_id ?? null, entity.area_id ?? null);
    }
    await back.click(); await expect(panel.locator('#settings-room-name')).toHaveValue(draftName);
    assert.equal((await ownArea()).name, name);
    await panel.locator('[data-settings-page="devices"]').click();
    await screenshot('assigned'); await narrowScreens('assigned');
  });

  await check('Mouse reordering saves once on drop and survives a full page reload', async () => {
    const before = await listOrder(), expected = moved(before, before.indexOf(fixtures.cover.key), 0), storedBefore = await savedOrder();
    assert.notDeepEqual(expected, before, 'Moving cover ahead of lights proves cross-domain order');
    const eventCount = settingsEvents.length;
    await moveRow(fixtures.cover.key, before[0]); await expect.poll(visualOrder).toEqual(expected);
    assert.deepEqual(await savedOrder(), storedBefore, 'A held drag is only a preview');
    await drop('mouse'); await assertOrder(expected);
    await expect.poll(() => settingsEvents.length).toBe(eventCount + 1);
    await page.reload(); await panel.locator('.room-card').first().waitFor({ timeout: 30000 });
    await openDevices(); await assertOrder(expected);
    assert.equal((await ownArea()).name, name);
  });

  await check('Room detail honors cross-domain order, retains climate only in its header and keeps targeted device gestures', async () => {
    const order = await savedOrder(), controls = selected.filter(item => item !== fixtures.temperature);
    const expected = order.filter(key => controls.some(item => item.key === key)).map(key => controls.find(item => item.key === key).entity.entity_id);
    await openDetail();
    assert.deepEqual(await currentRoom.locator('.device-section h2').allTextContents(), ['Geräte']);
    assert.deepEqual(await currentRoom.locator('[data-entity-row]').evaluateAll(nodes => nodes.map(node => node.dataset.entityRow)), expected);
    await expect(currentRoom.locator('[data-entity-row^="sensor."], [data-entity-row^="binary_sensor."]')).toHaveCount(0);
    const temperature = (await ha.call('get_states')).find(item => item.entity_id === fixtures.temperature.entity.entity_id);
    await expect(currentRoom.locator('.detail-climate')).toContainText(new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(Number(temperature.state)));
    await panel.evaluate(el => {
      const connection = el.hass.connection, originalSend = connection.sendMessagePromise;
      if (typeof originalSend !== 'function') throw new Error('Cannot safely intercept service transport');
      const probe = window.__deviceGestureProbe = { connection, originalSend, calls: [], details: [] };
      connection.sendMessagePromise = function (message) {
        if (message.type === 'call_service') {
          probe.calls.push([message.domain, message.service, { ...message.service_data, ...message.target }]);
          return Promise.resolve({});
        }
        return originalSend.call(this, message);
      };
      probe.listener = event => probe.details.push(event.detail.entityId);
      el.addEventListener('hass-more-info', probe.listener);
    });
    try {
      for (const [index, kind, item, fraction] of [[0, 'light', fixtures.light, .73], [1, 'cover', fixtures.cover, .37]]) {
        const range = currentRoom.locator(`[data-inline-range="${item.entity.entity_id}"]`); await range.scrollIntoViewIfNeeded();
        const box = await range.boundingBox();
        await page.mouse.move(box.x + box.width * .5, box.y + box.height / 2); await page.mouse.down();
        await page.mouse.move(box.x + box.width * fraction, box.y + box.height / 2, { steps: 5 });
        const value = Number(await range.inputValue()); assert.ok(Math.abs(value - fraction * 100) <= 1);
        assert.equal(await page.evaluate(() => window.__deviceGestureProbe.calls.length), index);
        await page.mouse.up(); await expect.poll(() => page.evaluate(() => window.__deviceGestureProbe.calls.length)).toBe(index + 1);
        const call = await page.evaluate(index => window.__deviceGestureProbe.calls[index], index);
        assert.equal(call[0], kind); assert.equal(call[1], kind === 'light' ? 'turn_on' : 'set_cover_position');
        assert.deepEqual(call[2].entity_id, [item.entity.entity_id]); assert.equal(call[2][kind === 'light' ? 'brightness_pct' : 'position'], value);
      }
      await expect(currentRoom.locator(`[data-inline-range="${fixtures.binary.entity.entity_id}"]`)).toHaveCount(0);
      assert.deepEqual(await page.evaluate(() => window.__deviceGestureProbe.details), []);
      await currentRoom.locator(`[data-inline-details="${fixtures.light.entity.entity_id}"]`).click();
      const nativeDialog = page.locator('ha-more-info-dialog').getByRole('dialog'); await expect(nativeDialog).toBeVisible();
      assert.deepEqual(await page.evaluate(() => window.__deviceGestureProbe.details), [fixtures.light.entity.entity_id]);
      await page.keyboard.press('Escape'); await expect(nativeDialog).not.toBeVisible();
    } finally {
      await page.keyboard.press('Escape'); await page.mouse.up();
      await panel.evaluate(el => {
        const probe = window.__deviceGestureProbe;
        probe.connection.sendMessagePromise = probe.originalSend;
        el.removeEventListener('hass-more-info', probe.listener);
        delete window.__deviceGestureProbe;
      });
    }
  });

  await check('Touch and keyboard reorder devices; Escape discards a drag without changing the saved order', async () => {
    await openDevices();
    let before = await listOrder(), expected = moved(before, before.length - 1, 0);
    await moveRow(before.at(-1), before[0], 'touch'); await expect.poll(visualOrder).toEqual(expected);
    await drop('touch'); await assertOrder(expected);
    before = expected; expected = moved(before, 0, before.length - 1);
    await handle(before[0]).focus(); await page.keyboard.press('Space'); await page.keyboard.press('End');
    await expect.poll(visualOrder).toEqual(expected); assert.deepEqual(await savedOrder(), before);
    await page.keyboard.press('Enter'); await assertOrder(expected);
    await moveRow(expected[0], expected.at(-1)); await page.keyboard.press('Escape'); await page.mouse.up();
    await assertOrder(expected);
    await expect(panel.locator('#settings-device-order-status')).not.toHaveText('');
  });

  await check('A rejected order save restores the previous order and displays an actionable error', async () => {
    const before = await listOrder();
    await panel.evaluate((el, areaId) => {
      const hass = el.hass, original = hass.callWS;
      window.__deviceOrderFailure = { hass, original, calls: 0 };
      hass.callWS = function (message) {
        if (message.type === 'easy_hass/room_device_order/set' && message.area_id === areaId) {
          window.__deviceOrderFailure.calls++; return Promise.reject(new Error('Test: Reihenfolge konnte nicht gespeichert werden.'));
        }
        return original.call(this, message);
      };
    }, area.area_id);
    try {
      await handle(before[0]).focus(); await page.keyboard.press('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => window.__deviceOrderFailure.calls)).toBe(1);
      await expect(panel.locator('.sheet [role="alert"]')).toContainText('Reihenfolge');
      await assertOrder(before);
    } finally {
      await page.evaluate(() => { const test = window.__deviceOrderFailure; test.hass.callWS = test.original; delete window.__deviceOrderFailure; });
    }
  });

  await check('Removing an assigned device clears only its native area and persists; the room remains editable on narrow dark screens', async () => {
    await remove(fixtures.binary.key).click(); await expect(row(fixtures.binary.key)).toHaveCount(0);
    await expect.poll(() => deviceArea(fixtures.binary.device.id)).toBe(null);
    for (const item of selected.filter(item => item !== fixtures.binary)) assert.equal(await deviceArea(item.device.id), area.area_id);
    await page.reload(); await panel.locator('.room-card').first().waitFor({ timeout: 30000 });
    await openDevices(); await expect(row(fixtures.binary.key)).toHaveCount(0);
    await add.click(); await search.fill(fixtures.binary.device.name); await expect(assign(fixtures.binary.key)).toContainText('Keinem Raum zugeordnet');
    await back.click();
    await panel.evaluate(el => { localStorage.setItem(el._themeKey(), 'dark'); el._applyTheme(); });
    await page.setViewportSize({ width: 320, height: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const key of await listOrder()) { const box = await handle(key).boundingBox(); assert.ok(box.width >= 44 && box.height >= 44); }
    await screenshot('narrow-dark');
    await openDetail(); await expect(currentRoom.locator(`[data-entity-row="${fixtures.binary.entity.entity_id}"]`)).toHaveCount(0);
    await expect(currentRoom.locator('[data-entity-row^="sensor."]')).toHaveCount(0);
    assert.equal((await ownArea()).name, name); assert.equal((await ownArea()).picture ?? null, area.picture ?? null);
    assert.deepEqual(actualServices, [], 'Assignment, order and browser-only gesture probes never actuate devices');
    assert.equal(stateHash((await ha.call('get_states')).filter(item => selectedIds.has(item.entity_id))), initialStates);
  });
  report.haServiceCalls = actualServices.length;
  assert.deepEqual(report.errors, []);
} catch (error) {
  failure = error;
  if (page) await page.screenshot({ path: 'test-results/room-devices-failure.png' }).catch(() => {});
} finally {
  const cleanup = async run => { try { await run(); } catch (error) { report.errors.push(`Cleanup: ${error.message}`); } };
  if (page) {
    if (activeTouch && cdp) await cleanup(() => cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }));
    await cleanup(() => page.keyboard.press('Escape')); await cleanup(() => page.mouse.up());
    await cleanup(() => page.locator('easy-hass-panel').evaluate((el, appearance) => {
      if (window.__deviceGestureProbe) {
        const probe = window.__deviceGestureProbe;
        probe.connection.sendMessagePromise = probe.originalSend;
        el.removeEventListener('hass-more-info', probe.listener);
        delete window.__deviceGestureProbe;
      }
      if (window.__deviceOrderFailure) { const test = window.__deviceOrderFailure; test.hass.callWS = test.original; }
      if (appearance) { if (appearance.value === null) localStorage.removeItem(appearance.key); else localStorage.setItem(appearance.key, appearance.value); el._applyTheme(); }
    }, appearance));
  }
  if (ha && fixtures) {
    for (const item of Object.values(fixtures)) await cleanup(() => ha.call('config/device_registry/update', { device_id: item.device.id, area_id: item.device.area_id ?? null }));
    const deviceIds = new Set(Object.values(fixtures).map(item => item.device.id));
    await cleanup(async () => {
      const entities = await ha.call('config/entity_registry/list');
      for (const entity of initialEntities.filter(item => deviceIds.has(item.device_id))) {
        if ((entities.find(item => item.entity_id === entity.entity_id)?.area_id ?? null) !== (entity.area_id ?? null)) {
          await cleanup(() => ha.call('config/entity_registry/update', { entity_id: entity.entity_id, area_id: entity.area_id ?? null }));
        }
      }
    });
  }
  if (ha && area) {
    await cleanup(() => ha.call('easy_hass/room_device_order/set', { area_id: area.area_id, keys: [] }));
    await cleanup(async () => { const own = (await ha.call('config/area_registry/list')).find(item => item.area_id === area.area_id); assert.equal(own?.name, name, 'Only delete this run’s own test area'); await ha.call('config/area_registry/delete', { area_id: area.area_id }); });
  }
  if (ha && initialAreas && fixtures) await cleanup(async () => {
    const [areas, devices, entities, settings, states] = await Promise.all([ha.call('config/area_registry/list'), ha.call('config/device_registry/list'), ha.call('config/entity_registry/list'), ha.call('easy_hass/settings/get'), ha.call('get_states')]);
    assert.deepEqual(areas.map(item => [item.area_id, item.name, item.picture]), initialAreas.map(item => [item.area_id, item.name, item.picture]));
    assert.deepEqual(devices.map(item => [item.id, item.area_id]), initialDevices.map(item => [item.id, item.area_id]));
    assert.deepEqual(entities.map(item => [item.entity_id, item.area_id]), initialEntities.map(item => [item.entity_id, item.area_id]));
    assert.deepEqual(settings, initialSettings);
    const ids = new Set(Object.values(fixtures).map(item => item.entity.entity_id));
    assert.equal(stateHash(states.filter(item => ids.has(item.entity_id))), initialStates);
    assert.deepEqual(actualServices, []); report.cleanup = 'Original assignments, settings, state values and areas restored';
  });
  if (browser) await cleanup(() => browser.close()); ha?.close();
  await writeFile('test-results/browser-room-devices.json', `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.results.filter(result => result.pass).length, report: 'test-results/browser-room-devices.json' }));
if (failure) throw failure;
if (report.errors.length) throw new Error('Room-device checks reported browser or cleanup errors');
