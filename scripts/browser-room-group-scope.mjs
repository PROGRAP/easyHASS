/** Real HA group/area boundaries; every device service is intercepted in the browser. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { LocalHA } from './ha-client.mjs';
import { localBrowser } from './browser-login.mjs';

const report = { at: new Date().toISOString(), results: [], errors: [], screenshots: [] };
const prefix = `Easy-Hass Test Gruppengrenze ${Date.now()}-${randomUUID().slice(0, 5)}`, groupName = `${prefix} Gruppe`;
const areas = [], serviceEvents = [];
let ha, browser, page, fixtures, initial, groupFlow, groupEntry, groupEntity, failure;
const stateHash = states => createHash('sha256').update(JSON.stringify(states.map(({ entity_id, state, attributes }) => ({ entity_id, state, attributes })).sort((a, b) => a.entity_id.localeCompare(b.entity_id)))).digest('hex');
const check = async (name, run) => {
  try { await run(); report.results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.results.push({ name, pass: false, error: error.stack || String(error) }); throw error; }
};
await mkdir('test-results', { recursive: true });
try {
  ha = await LocalHA.open();
  const [registryAreas, devices, entities, settings, states, entries] = await Promise.all([
    ha.call('config/area_registry/list'), ha.call('config/device_registry/list'), ha.call('config/entity_registry/list'),
    ha.call('easy_hass/settings/get'), ha.call('get_states'), ha.call('config_entries/get'),
  ]);
  const fixture = suffix => {
    const entity = entities.find(item => item.unique_id === `easy_hass_test_${suffix}`);
    const device = devices.find(item => item.id === entity?.device_id);
    assert.equal(device?.manufacturer, 'Easy-Hass test fixture', 'Never move a real device');
    assert.equal(entity.area_id ?? null, null, 'Use inherited-area test fixtures only');
    assert.equal(entity.hidden_by ?? null, null); assert.equal(entity.disabled_by ?? null, null);
    return { entity, device, key: `device:${device.id}` };
  };
  fixtures = [fixture('living_light'), fixture('living_onoff')];
  assert.notEqual(fixtures[0].device.id, fixtures[1].device.id);
  const memberIds = fixtures.map(item => item.entity.entity_id).sort();
  initial = { areas: registryAreas, devices, entities, settings, entries: entries.map(item => item.entry_id).sort(), states: stateHash(states.filter(item => memberIds.includes(item.entity_id))) };
  await ha.call('subscribe_events', { event_type: 'call_service' }, event => serviceEvents.push(event.data));
  for (const suffix of ['A', 'B']) areas.push(await ha.call('config/area_registry/create', { name: `${prefix} ${suffix}` }));
  const [a, b] = areas;
  for (const item of fixtures) await ha.call('config/device_registry/update', { device_id: item.device.id, area_id: a.area_id });
  const start = await ha.api('/api/config/config_entries/flow', { handler: 'group' });
  groupFlow = start.flow_id; assert.equal(start.type, 'menu');
  const form = await ha.api(`/api/config/config_entries/flow/${groupFlow}`, { next_step_id: 'light' });
  assert.equal(form.type, 'form'); assert.equal(form.step_id, 'light');
  const created = await ha.api(`/api/config/config_entries/flow/${groupFlow}`, { name: groupName, entities: memberIds, hide_members: false, all: false });
  assert.equal(created.type, 'create_entry'); groupEntry = created.result.entry_id; groupFlow = null;
  await expect.poll(async () => {
    groupEntity = (await ha.call('config/entity_registry/list')).find(item => item.platform === 'group' && item.config_entry_id === groupEntry);
    return Boolean(groupEntity);
  }).toBe(true);
  assert.equal(groupEntity.device_id ?? null, null, 'The owned HA helper is an independently assigned group entity');
  const groupKey = `entity:${groupEntity.entity_id}`;
  await ha.call('config/entity_registry/update', { entity_id: groupEntity.entity_id, area_id: b.area_id });
  await expect.poll(async () => (await ha.call('get_states')).find(item => item.entity_id === groupEntity.entity_id)?.attributes.entity_id?.slice().sort()).toEqual(memberIds);
  ({ browser, page } = await localBrowser({ reducedMotion: 'reduce' }));
  page.on('pageerror', error => report.errors.push(error.message));
  const panel = page.locator('easy-hass-panel'), current = panel.locator('.room-detail[data-current-room]');
  const title = panel.locator('#settings-title');
  const card = area => panel.locator(`[data-room-card="${area.area_id}"]`);
  const groupRow = () => current.locator(`[data-entity-row="${groupEntity.entity_id}"]`);
  const settingsRows = () => panel.locator('[data-settings-device-row]').evaluateAll(nodes => nodes.map(node => node.dataset.settingsDeviceRow).sort());
  const groupArea = async () => (await ha.call('config/entity_registry/list')).find(item => item.entity_id === groupEntity.entity_id)?.area_id ?? null;
  const settingsSnapshot = () => ha.call('easy_hass/settings/get');
  const installTransport = () => panel.evaluate(el => {
    const connection = el.hass.connection, originalSend = connection.sendMessagePromise;
    if (typeof originalSend !== 'function') throw new Error('Service interception is required');
    const probe = window.__groupScopeTransport = { calls: [] };
    connection.sendMessagePromise = function (message) {
      if (message.type === 'call_service') { probe.calls.push(message); return Promise.resolve({}); }
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
  const detail = async area => {
    await dismiss(); await card(area).locator('[data-open-room]').click();
    await expect(current).toHaveAttribute('data-room-detail', area.area_id);
  };
  const devicesPage = async area => {
    await dismiss(); await panel.locator('[data-tab="more"]').click(); await panel.locator('[data-settings-page="settings"]').click();
    await panel.locator('[data-settings-page="rooms"]').click(); await panel.locator(`[data-settings-area="${area.area_id}"]`).click();
    await panel.locator('[data-settings-page="devices"]').click(); await expect(title).toHaveText('Geräte');
  };
  const chooseGroup = async (area, mode) => {
    await devicesPage(area); await panel.locator('[data-settings-device-add]').click();
    await panel.locator('#settings-device-search').fill(groupName);
    await panel.locator(`[data-settings-device-assign="${groupKey}"]`).click();
    await panel.locator(`[data-settings-device-mode="${mode}"]`).click(); await expect(title).toHaveText('Geräte');
    await expect(panel.locator('[data-settings-device-add]')).toBeEnabled();
  };
  const homeTargets = async (area, expected) => {
    await dismiss();
    await expect.poll(() => panel.evaluate((el, id) => el._home.rooms.find(room => room.id === id)?.lights.map(item => item.id).sort(), area.area_id)).toEqual([...expected].sort());
    const button = card(area).locator('[data-control="light"]'); await expect(button).toBeEnabled();
    await panel.evaluate(() => { window.__groupScopeTransport.calls.length = 0; }); await button.click();
    await expect.poll(() => page.evaluate(() => window.__groupScopeTransport.calls.length)).toBeGreaterThan(0);
    await expect(button).toBeEnabled();
    const calls = await page.evaluate(() => window.__groupScopeTransport.calls);
    assert.ok(calls.every(call => call.domain === 'light' && ['turn_on', 'turn_off'].includes(call.service)));
    const targets = calls.flatMap(call => { const ids = call.target?.entity_id || call.service_data?.entity_id || []; return Array.isArray(ids) ? ids : [ids]; });
    assert.deepEqual(targets.sort(), [...expected].sort(), 'The visible room shortcut targets only that room’s displayed members or explicit group');
  };
  const detailRows = async (area, expected) => {
    await detail(area);
    await expect.poll(() => current.locator('[data-entity-row]').evaluateAll(nodes => nodes.map(node => node.dataset.entityRow).sort())).toEqual([...expected].sort());
    await expect(current.locator('.device-section h2')).toHaveText('Licht');
  };
  const assertNativeMembers = async () => {
    await homeTargets(a, memberIds); await detailRows(a, memberIds);
    await expect(groupRow()).toHaveCount(0);
    await devicesPage(a); await expect.poll(settingsRows).toEqual(fixtures.map(item => item.key).sort());
  };
  const assertLocalGroup = async area => { await homeTargets(area, [groupEntity.entity_id]); await detailRows(area, [groupEntity.entity_id]); await expect(groupRow().locator('.device-state')).toContainText('Gruppe'); };
  const screenshot = async suffix => { const path = `test-results/room-group-scope-${suffix}.png`; await page.screenshot({ path }); report.screenshots.push(path); };
  const reload = async () => { await dismiss(); await page.reload(); await panel.locator('.room-card').first().waitFor({ timeout: 30000 }); await installTransport(); };
  await installTransport();
  report.revision = await panel.evaluate(el => el.shadowRoot.querySelector('link[rel=stylesheet]').href.match(/builds\/([^/]+)/)?.[1]);
  report.fixture = { roomA: a.area_id, roomB: b.area_id, members: memberIds, group: groupEntity.entity_id };

  await check('A foreign-room group cannot replace native room members in home, details or device settings', async () => {
    await assertNativeMembers(); await detailRows(a, memberIds); await screenshot('foreign-group-members');
    await assertLocalGroup(b); await devicesPage(b); await expect.poll(settingsRows).toEqual([groupKey]);
    assert.equal(await groupArea(), b.area_id);
  });

  await check('An unassigned group cannot replace native room members either', async () => {
    await ha.call('config/entity_registry/update', { entity_id: groupEntity.entity_id, area_id: null });
    await assertNativeMembers(); assert.equal(await groupArea(), null);
    await ha.call('config/entity_registry/update', { entity_id: groupEntity.entity_id, area_id: b.area_id });
    await assertLocalGroup(b);
  });

  await check('Explicitly displaying the group in the member room suppresses its members there and persists after reload', async () => {
    await chooseGroup(a, 'additional');
    await expect.poll(async () => (await settingsSnapshot()).room_device_links[a.area_id]).toEqual([groupKey]);
    assert.equal(await groupArea(), b.area_id); await reload();
    await assertLocalGroup(a); await screenshot('explicit-group');
    await devicesPage(a); await expect.poll(settingsRows).toEqual([...fixtures.map(item => item.key), groupKey].sort());
    await expect(panel.locator(`[data-settings-device-row="${groupKey}"]`)).toHaveAttribute('data-additional', 'true');
    await assertLocalGroup(b);
  });

  await check('Removing the additional group display restores native members without changing the group’s own room', async () => {
    await devicesPage(a); await panel.locator(`[data-settings-device-remove="${groupKey}"]`).click();
    await expect.poll(async () => (await settingsSnapshot()).room_device_links[a.area_id] || []).toEqual([]);
    await assertNativeMembers(); await assertLocalGroup(b); assert.equal(await groupArea(), b.area_id);
  });

  await check('Native group moves suppress members only in the group’s current room, including after reload', async () => {
    await chooseGroup(a, 'move'); await expect.poll(groupArea).toBe(a.area_id);
    await reload(); await assertLocalGroup(a);
    await devicesPage(a); await expect.poll(settingsRows).toEqual([...fixtures.map(item => item.key), groupKey].sort());
    await expect(panel.locator(`[data-settings-device-row="${groupKey}"]`)).not.toHaveAttribute('data-additional', 'true');
    await chooseGroup(b, 'move'); await expect.poll(groupArea).toBe(b.area_id);
    await reload(); await assertNativeMembers(); await detailRows(a, memberIds); await screenshot('moved-away-members');
    await assertLocalGroup(b);
    assert.deepEqual((await settingsSnapshot()).room_device_links, initial.settings.room_device_links);
  });
  assert.deepEqual(serviceEvents, []); report.haServiceCalls = 0; assert.deepEqual(report.errors, []);
} catch (error) {
  failure = error; if (page) await page.screenshot({ path: 'test-results/room-group-scope-failure.png' }).catch(() => {});
} finally {
  const cleanup = async run => { try { await run(); } catch (error) { report.errors.push(`Cleanup: ${error.message}`); } };
  if (page) { await cleanup(() => page.keyboard.press('Escape')); await cleanup(() => page.mouse.up()); }
  if (browser) await cleanup(() => browser.close());
  if (ha) for (const area of areas) {
    if (groupEntity) await cleanup(() => ha.call('easy_hass/room_device_link/set', { area_id: area.area_id, key: `entity:${groupEntity.entity_id}`, linked: false }));
    await cleanup(() => ha.call('easy_hass/room_device_order/set', { area_id: area.area_id, keys: [] }));
  }
  if (ha && groupEntry) await cleanup(async () => {
    const own = (await ha.call('config_entries/get')).find(item => item.entry_id === groupEntry);
    assert.equal(own?.domain, 'group'); assert.equal(own?.title, groupName, 'Only remove this run’s owned group helper');
    await ha.api(`/api/config/config_entries/entry/${groupEntry}`, undefined, 'DELETE');
  });
  if (ha && groupFlow) await cleanup(() => ha.api(`/api/config/config_entries/flow/${groupFlow}`, undefined, 'DELETE'));
  if (ha && fixtures) for (const item of fixtures) await cleanup(() => ha.call('config/device_registry/update', { device_id: item.device.id, area_id: item.device.area_id ?? null }));
  if (ha) for (const area of areas) await cleanup(async () => {
    const own = (await ha.call('config/area_registry/list')).find(item => item.area_id === area.area_id);
    assert.equal(own?.name, area.name); assert.ok(area.name.startsWith(prefix)); await ha.call('config/area_registry/delete', { area_id: area.area_id });
  });
  if (ha && initial) await cleanup(async () => {
    const [areas, devices, entities, settings, states, entries] = await Promise.all([
      ha.call('config/area_registry/list'), ha.call('config/device_registry/list'), ha.call('config/entity_registry/list'),
      ha.call('easy_hass/settings/get'), ha.call('get_states'), ha.call('config_entries/get'),
    ]);
    assert.deepEqual(areas.map(item => [item.area_id, item.name, item.picture]), initial.areas.map(item => [item.area_id, item.name, item.picture]));
    assert.deepEqual(devices.map(item => [item.id, item.area_id]), initial.devices.map(item => [item.id, item.area_id]));
    assert.deepEqual(entities.map(item => [item.entity_id, item.area_id, item.hidden_by]), initial.entities.map(item => [item.entity_id, item.area_id, item.hidden_by]));
    assert.deepEqual(settings, initial.settings); assert.deepEqual(entries.map(item => item.entry_id).sort(), initial.entries);
    const ids = fixtures.map(item => item.entity.entity_id);
    assert.equal(stateHash(states.filter(item => ids.includes(item.entity_id))), initial.states); assert.deepEqual(serviceEvents, []);
    assert.equal(states.some(item => item.entity_id === groupEntity?.entity_id), false);
    report.cleanup = 'Owned group/helper removed; all native assignments, visibility, settings, areas and fixture states restored';
  });
  ha?.close(); await writeFile('test-results/browser-room-group-scope.json', `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.results.filter(item => item.pass).length, report: 'test-results/browser-room-group-scope.json' }));
if (failure) throw failure;
if (report.errors.length) throw new Error('Group scope checks reported browser or cleanup errors');
