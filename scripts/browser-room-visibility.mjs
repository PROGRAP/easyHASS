/** Persist visibility for one owned test area; never hide existing HA rooms. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { localBrowser } from './browser-login.mjs';
import { LocalHA, baseUrl } from './ha-client.mjs';

const report = { at: new Date().toISOString(), results: [], errors: [], screenshots: [] };
await mkdir('test-results', { recursive: true });
const areaName = `Easy-Hass Test Visibility ${Date.now()}-${randomUUID().slice(0, 6)}`;
const remoteAreaName = `${areaName} remote`, ownedNames = new Set([areaName, remoteAreaName]);
const serviceCalls = [], settingsEvents = [];
let ha, primary, secondary, initialAreas, initialDevices, initialEntities, initialSettings, initialStates, initialImages;
let area, areaOrder, appearance, failure, activeTouch = false, cdp;
const sorted = (items, key) => [...items].sort((a, b) => a[key].localeCompare(b[key]));
const hiddenIds = settings => [...settings.hidden_area_ids].sort();
const fingerprint = states => createHash('sha256').update(JSON.stringify(sorted(states
  .map(({ entity_id, state, attributes }) => ({ entity_id, state, attributes })), 'entity_id'))).digest('hex');
const check = async (name, run) => {
  try { await run(); report.results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.results.push({ name, pass: false, error: error.stack || String(error) }); throw error; }
};

try {
  ha = await LocalHA.open();
  [initialAreas, initialDevices, initialEntities, initialSettings, initialImages] = await Promise.all([
    ha.call('config/area_registry/list'), ha.call('config/device_registry/list'), ha.call('config/entity_registry/list'),
    ha.call('easy_hass/settings/get'), ha.call('image/list'),
  ]);
  assert.ok(Array.isArray(initialSettings.hidden_area_ids));
  const visibleOriginals = initialAreas.filter(item => !initialSettings.hidden_area_ids.includes(item.area_id));
  assert.ok(visibleOriginals.length >= 2, 'Two visible fixture rooms are needed for the swipe check');
  const fixtureIds = new Set(initialEntities.filter(entity => entity.unique_id?.startsWith('easy_hass_test_')).map(entity => entity.entity_id));
  initialStates = fingerprint((await ha.call('get_states')).filter(state => fixtureIds.has(state.entity_id)));
  await ha.call('subscribe_events', { event_type: 'call_service' }, event => serviceCalls.push(`${event.data.domain}.${event.data.service}`));
  await ha.call('easy_hass/settings/subscribe', {}, snapshot => settingsEvents.push({ hidden_area_ids: [...snapshot.hidden_area_ids] }));
  const picture = initialAreas.find(item => item.picture)?.picture;
  assert.ok(picture, 'Use an existing fixture image reference without uploading or deleting its asset');
  area = await ha.call('config/area_registry/create', { name: areaName, picture });
  assert.ok(area.area_id && !initialAreas.some(item => item.area_id === area.area_id));
  assert.ok(!initialSettings.hidden_area_ids.includes(area.area_id), 'Only a newly created visible test area may be hidden');
  areaOrder = (await ha.call('config/area_registry/list')).map(item => item.area_id);
  primary = await localBrowser({ reducedMotion: 'reduce', hasTouch: true });
  primary.page.on('pageerror', error => report.errors.push(`Primary: ${error.message}`));
  cdp = await primary.context.newCDPSession(primary.page);
  const { page } = primary, panel = page.locator('easy-hass-panel');
  const title = panel.locator('#settings-title'), form = panel.locator('.settings-form');
  const checkbox = panel.locator('#settings-room-hidden'), save = panel.locator('[data-settings-save]');
  const editRow = panel.locator(`[data-settings-area="${area.area_id}"]`);
  const card = panel.locator(`[data-room-card="${area.area_id}"]`);
  const actualSettings = () => ha.call('easy_hass/settings/get');
  const actualArea = async () => (await ha.call('config/area_registry/list')).find(item => item.area_id === area.area_id);
  const expectedHidden = [...initialSettings.hidden_area_ids, area.area_id].sort();
  const dismiss = async (client = primary) => {
    const target = client.page.locator('easy-hass-panel');
    for (let count = 0; count < 7 && await target.getByRole('dialog').count(); count++) await client.page.keyboard.press('Escape');
    await expect(target.getByRole('dialog')).toHaveCount(0);
  };
  const openRooms = async (client = primary) => {
    const target = client.page.locator('easy-hass-panel');
    await dismiss(client); await target.locator('[data-tab="more"]').click();
    await target.locator('[data-settings-page="settings"]').click(); await target.locator('[data-settings-page="rooms"]').click();
    await expect(target.locator('#settings-title')).toHaveText('Räume');
  };
  const editOwn = async () => { await openRooms(); await editRow.click(); await expect(form).toBeVisible(); };
  const screenshot = async name => {
    const path = `test-results/room-visibility-${name}.png`; await page.screenshot({ path }); report.screenshots.push(path);
  };
  const waitForHome = async (client = primary) => {
    await client.page.locator('easy-hass-panel .room-card').first().waitFor({ timeout: 30000 });
  };
  const swipeLeft = async () => {
    const surface = panel.locator('.room-detail[data-current-room]'), box = await surface.boundingBox();
    assert.ok(box && box.width > 200);
    const y = box.y + Math.min(130, box.height / 3), start = box.x + box.width * .82, end = box.x + box.width * .18;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start, y }] }); activeTouch = true;
    for (let step = 1; step <= 10; step++) await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: start + (end - start) * step / 10, y }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); activeTouch = false;
  };
  appearance = await panel.evaluate(el => ({ key: el._themeKey(), value: localStorage.getItem(el._themeKey()) }));
  await panel.evaluate(el => { localStorage.setItem(el._themeKey(), 'light'); el._applyTheme(); });

  await check('The real test area stays in settings and its visibility checkbox starts unchecked', async () => {
    await expect(card).toHaveCount(1); await editOwn();
    await expect(checkbox).toHaveAccessibleName(/In EasyHASS ausblenden/i); await expect(checkbox).not.toBeChecked();
    await expect(checkbox).toBeEnabled(); await expect(panel.locator('#settings-room-name')).toHaveValue(areaName);
    await expect(form.locator('.settings-picture-preview')).toBeVisible();
    await screenshot('edit-light');
  });

  await check('Cancelling a checked draft leaves server visibility and the home card unchanged', async () => {
    const eventsBefore = settingsEvents.length;
    await checkbox.check(); await expect(checkbox).toBeChecked();
    assert.deepEqual(hiddenIds(await actualSettings()), hiddenIds(initialSettings));
    await panel.locator('[data-settings-back]').click(); await expect(title).toHaveText('Räume');
    await editRow.click(); await expect(checkbox).not.toBeChecked();
    assert.deepEqual(hiddenIds(await actualSettings()), hiddenIds(initialSettings));
    assert.equal(settingsEvents.length, eventsBefore, 'A checkbox draft does not publish a settings update');
    await dismiss(); await expect(card).toHaveCount(1);
  });

  await check('Saving hides only the test area and synchronizes a second client with that room already open', async () => {
    secondary = await localBrowser({ reducedMotion: 'reduce', hasTouch: true });
    secondary.page.on('pageerror', error => report.errors.push(`Secondary: ${error.message}`));
    const other = secondary.page.locator('easy-hass-panel');
    await other.locator(`[data-open-room="${area.area_id}"]`).click();
    await expect(other.locator('.room-detail[data-current-room]')).toHaveAttribute('data-room-detail', area.area_id);
    await editOwn(); await checkbox.check(); await save.click();
    await expect.poll(async () => hiddenIds(await actualSettings())).toEqual(expectedHidden);
    await expect(title).toHaveText('Räume'); await expect(editRow).toContainText('Ausgeblendet');
    await expect(card).toHaveCount(0);
    await expect(other.locator(`[data-room-card="${area.area_id}"]`)).toHaveCount(0);
    await expect(other.locator(`[data-room-detail="${area.area_id}"]`)).toHaveCount(0);
    await expect(other.locator('.room-stage')).toHaveCount(0);
    assert.ok(settingsEvents.some(snapshot => snapshot.hidden_area_ids.includes(area.area_id)), 'The backend publishes the actual hidden state');
    assert.equal((await actualArea()).name, areaName); assert.equal((await actualArea()).picture, picture);
    await screenshot('hidden-row-light');
  });

  await check('Hidden rooms stay excluded after reload, direct routing and touch navigation', async () => {
    await page.reload(); await waitForHome(); await expect(card).toHaveCount(0);
    const visibleIds = visibleOriginals.map(item => item.area_id);
    await expect.poll(() => panel.locator('[data-room-card]').evaluateAll(items => items.map(item => item.dataset.roomCard)
      .filter(id => id !== '__easy_hass_unassigned__'))).toEqual(visibleIds);
    await panel.locator(`[data-open-room="${visibleIds.at(-2)}"]`).click();
    await expect(panel.locator('.room-detail[data-current-room]')).toHaveAttribute('data-room-detail', visibleIds.at(-2));
    await expect(panel.locator(`[data-room-detail="${area.area_id}"]`)).toHaveCount(0);
    await expect(panel.locator(`[data-room-page="${area.area_id}"]`)).toHaveCount(0);
    await swipeLeft(); await expect(panel.locator('.room-detail[data-current-room]')).toHaveAttribute('data-room-detail', visibleIds.at(-1));
    await swipeLeft(); await expect(panel.locator(`[data-room-detail="${area.area_id}"]`)).toHaveCount(0);
    await dismiss();
    await page.evaluate(id => { location.hash = `room=${encodeURIComponent(id)}`; }, area.area_id);
    await expect.poll(() => new URL(page.url()).hash).not.toBe(`#room=${encodeURIComponent(area.area_id)}`);
    await expect(panel.locator('.room-stage')).toHaveCount(0);
    await expect(panel.locator(`[data-room-detail="${area.area_id}"]`)).toHaveCount(0);
    // Force a full route load as well, so a stale in-memory filter cannot pass.
    await page.goto('about:blank'); await page.goto(`${baseUrl}/easy-hass#room=${encodeURIComponent(area.area_id)}`); await waitForHome();
    await expect(card).toHaveCount(0); await expect(panel.locator(`[data-room-detail="${area.area_id}"]`)).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).hash).not.toBe(`#room=${encodeURIComponent(area.area_id)}`);
    await expect(panel.locator('.room-stage')).toHaveCount(0);
    await editOwn(); await expect(checkbox).toBeChecked();
  });

  await check('A failed visibility save keeps the persisted hidden state and exposes the unsaved draft with an error', async () => {
    await checkbox.uncheck();
    await panel.evaluate((el, areaId) => {
      const hass = el.hass, original = hass.callWS;
      const test = window.__visibilityFailure = { hass, original, calls: 0 };
      hass.callWS = function (message) {
        if (message.type === 'easy_hass/room_visibility/set' && message.area_id === areaId) {
          test.calls++; return Promise.reject(new Error('Test: Sichtbarkeit konnte nicht gespeichert werden.'));
        }
        return original.call(this, message);
      };
    }, area.area_id);
    try {
      await save.click(); await expect.poll(() => page.evaluate(() => window.__visibilityFailure.calls)).toBe(1);
      await expect(form.locator('#settings-error')).toHaveAttribute('role', 'alert');
      await expect(form.locator('#settings-error')).toContainText(/nicht gespeichert|Sichtbarkeit/);
      await expect(checkbox).not.toBeChecked(); await expect(save).toBeEnabled();
      assert.deepEqual(hiddenIds(await actualSettings()), expectedHidden); await expect(card).toHaveCount(0);
      await screenshot('save-error');
    } finally {
      await page.evaluate(() => {
        const test = window.__visibilityFailure;
        if (test) { test.hass.callWS = test.original; delete window.__visibilityFailure; }
      });
    }
    await panel.locator('[data-settings-back]').click(); await editRow.click(); await expect(checkbox).toBeChecked();
  });

  await check('Offline and non-admin UI states disable visibility changes without sending a write', async () => {
    for (const mode of ['offline', 'nonadmin']) {
      await panel.evaluate((el, mode) => {
        window.__visibilityOriginalHass = el.hass;
        el.hass = mode === 'offline' ? { ...el.hass, connected: false } : { ...el.hass, user: { ...el.hass.user, is_admin: false } };
      }, mode);
      try {
        await expect(checkbox).toBeDisabled(); await expect(save).toBeDisabled();
        await expect(form.locator('.settings-help')).toContainText(mode === 'offline' ? /Verbindung/ : /Administrator/);
        assert.deepEqual(hiddenIds(await actualSettings()), expectedHidden);
      } finally {
        await panel.evaluate(el => { el.hass = window.__visibilityOriginalHass; delete window.__visibilityOriginalHass; });
      }
      await expect(checkbox).toBeEnabled(); await expect(save).toBeEnabled();
    }
  });

  await check('Unhiding restores the card in both clients and remains visible in a fresh signed-in browser', async () => {
    await checkbox.uncheck(); await save.click();
    await expect.poll(async () => hiddenIds(await actualSettings())).toEqual(hiddenIds(initialSettings));
    await expect(title).toHaveText('Räume'); await expect(editRow).not.toContainText('Ausgeblendet');
    await expect(card).toHaveCount(1);
    await expect(secondary.page.locator(`easy-hass-panel [data-room-card="${area.area_id}"]`)).toHaveCount(1);
    await page.reload(); await waitForHome(); await expect(card).toHaveCount(1);
    await editOwn(); await expect(checkbox).not.toBeChecked();
    await secondary.browser.close(); secondary = null;
    secondary = await localBrowser({ reducedMotion: 'reduce', hasTouch: true });
    secondary.page.on('pageerror', error => report.errors.push(`Fresh client: ${error.message}`));
    await expect(secondary.page.locator(`easy-hass-panel [data-room-card="${area.area_id}"]`)).toHaveCount(1);
    await openRooms(secondary); await secondary.page.locator(`[data-settings-area="${area.area_id}"]`).click();
    await expect(secondary.page.locator('#settings-room-hidden')).not.toBeChecked();
    await panel.evaluate(el => { localStorage.setItem(el._themeKey(), 'dark'); el._applyTheme(); });
    await screenshot('edit-dark');
  });

  await check('A visibility-only save preserves a concurrent remote rename of the test area', async () => {
    // The current form was opened before the remote change and still contains
    // its old name. Only the checkbox is edited locally, so that old name must
    // never overwrite the actual newer HA name.
    await expect(panel.locator('#settings-room-name')).toHaveValue(areaName);
    await ha.call('config/area_registry/update', { area_id: area.area_id, name: remoteAreaName });
    await expect(card.locator('h2')).toHaveText(remoteAreaName);
    await expect(panel.locator('#settings-room-name')).toHaveValue(areaName);
    await checkbox.check(); await save.click();
    await expect.poll(async () => hiddenIds(await actualSettings())).toEqual(expectedHidden);
    assert.equal((await actualArea()).name, remoteAreaName, 'A visibility-only draft must not save its stale name');
    assert.equal((await actualArea()).picture, picture);
    await expect(title).toHaveText('Räume'); await expect(editRow).toContainText(remoteAreaName);
    await editRow.click(); await expect(panel.locator('#settings-room-name')).toHaveValue(remoteAreaName);
    await checkbox.uncheck(); await save.click();
    await expect.poll(async () => hiddenIds(await actualSettings())).toEqual(hiddenIds(initialSettings));
    assert.equal((await actualArea()).name, remoteAreaName);
    // Restore only this run's fixture so the final invariants remain exact.
    await ha.call('config/area_registry/update', { area_id: area.area_id, name: areaName });
    await expect(card.locator('h2')).toHaveText(areaName);
  });

  await check('Visibility preserves native area names, pictures, order, existing preferences and every device', async () => {
    const areas = await ha.call('config/area_registry/list');
    assert.deepEqual(areas.map(item => item.area_id), areaOrder);
    assert.deepEqual(areas.filter(item => item.area_id !== area.area_id), initialAreas);
    assert.equal((await actualArea()).name, areaName); assert.equal((await actualArea()).picture, picture);
    assert.deepEqual(await actualSettings(), initialSettings);
    assert.deepEqual(sorted(await ha.call('config/device_registry/list'), 'id'), sorted(initialDevices, 'id'));
    assert.deepEqual(sorted(await ha.call('config/entity_registry/list'), 'entity_id'), sorted(initialEntities, 'entity_id'));
    assert.deepEqual(sorted(await ha.call('image/list'), 'id'), sorted(initialImages, 'id'));
    assert.equal(fingerprint((await ha.call('get_states')).filter(state => fixtureIds.has(state.entity_id))), initialStates);
    assert.deepEqual(serviceCalls, []); assert.deepEqual(report.errors, []);
  });
} catch (error) {
  failure = error;
  if (!report.results.some(result => !result.pass)) report.errors.push(error.stack || String(error));
  if (primary?.page) await primary.page.screenshot({ path: 'test-results/room-visibility-failure.png' }).catch(() => {});
} finally {
  const cleanup = async run => { try { await run(); } catch (error) { report.errors.push(`Cleanup: ${error.message}`); } };
  if (activeTouch) await cleanup(() => cdp?.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }));
  if (primary?.page && appearance) await cleanup(() => primary.page.locator('easy-hass-panel').evaluate((el, saved) => {
    if (saved.value === null) localStorage.removeItem(saved.key); else localStorage.setItem(saved.key, saved.value);
    el._applyTheme();
  }, appearance));
  if (primary?.browser) await cleanup(() => primary.browser.close());
  if (secondary?.browser) await cleanup(() => secondary.browser.close());
  if (ha && area) await cleanup(async () => {
    const own = (await ha.call('config/area_registry/list')).find(item => item.area_id === area.area_id);
    assert.ok(!initialAreas.some(item => item.area_id === area.area_id) && ownedNames.has(own?.name)
      && areaName.startsWith('Easy-Hass Test Visibility '), 'Only this exact run-owned area may be changed or deleted');
    // Merge only this one ID; never overwrite preferences for existing rooms.
    await ha.call('easy_hass/room_visibility/set', { area_id: area.area_id, hidden: false });
    await ha.call('config/area_registry/delete', { area_id: area.area_id });
    assert.deepEqual(await ha.call('easy_hass/settings/get'), initialSettings);
    assert.deepEqual(await ha.call('config/area_registry/list'), initialAreas);
    report.cleanup = { deletedAreaId: area.area_id, originalSettingsPreserved: true, originalAreaOrderPreserved: true };
  });
  ha?.close(); report.haServiceCalls = serviceCalls.length; report.settingsUpdates = settingsEvents.length;
  await writeFile('test-results/browser-room-visibility.json', `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.results.filter(result => result.pass).length, report: 'test-results/browser-room-visibility.json', haServiceCalls: serviceCalls.length }));
if (failure) throw failure;
if (report.errors.length) throw new Error('Room visibility checks reported browser or cleanup errors; see report');
