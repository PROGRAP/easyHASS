/** Reorder actual local HA areas through the UI, then restore the exact order. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { localBrowser } from './browser-login.mjs';
import { LocalHA } from './ha-client.mjs';

const report = { at: new Date().toISOString(), results: [], errors: [], screenshots: [] };
await mkdir('test-results', { recursive: true });
const suffix = `${Date.now()}-${randomUUID().slice(0, 6)}`;
const temporaryAreas = new Map(), serviceCalls = [], registryReorders = [];
let ha, browser, context, page, cdp, initialAreas, initialDevices, initialEntities, initialStates, appearance, failure;
let activeMouse = false, activeTouch = false;
const ids = areas => areas.map(area => area.area_id);
const sorted = (items, key) => [...items].sort((a, b) => a[key].localeCompare(b[key]));
const fingerprint = states => createHash('sha256').update(JSON.stringify(sorted(states
  .map(({ entity_id, state, attributes }) => ({ entity_id, state, attributes })), 'entity_id'))).digest('hex');
const moved = (order, from, to) => {
  const result = [...order], [id] = result.splice(from, 1); result.splice(to, 0, id); return result;
};
const check = async (name, run) => {
  try { await run(); report.results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.results.push({ name, pass: false, error: error.stack || String(error) }); throw error; }
};

try {
  ha = await LocalHA.open();
  [initialAreas, initialDevices, initialEntities] = await Promise.all([
    ha.call('config/area_registry/list'), ha.call('config/device_registry/list'), ha.call('config/entity_registry/list'),
  ]);
  assert.ok(initialAreas.length >= 3, 'At least three real local HA areas are needed');
  const fixtureIds = new Set(initialEntities.filter(entity => entity.unique_id?.startsWith('easy_hass_test_')).map(entity => entity.entity_id));
  initialStates = fingerprint((await ha.call('get_states')).filter(state => fixtureIds.has(state.entity_id)));
  await ha.call('subscribe_events', { event_type: 'call_service' }, event => serviceCalls.push(`${event.data.domain}.${event.data.service}`));
  await ha.call('subscribe_events', { event_type: 'area_registry_updated' }, event => {
    if (event.data.action === 'reorder') registryReorders.push({ action: event.data.action, area_id: event.data.area_id });
  });
  ({ browser, context, page } = await localBrowser({ reducedMotion: 'reduce', hasTouch: true }));
  cdp = await context.newCDPSession(page);
  page.on('pageerror', error => report.errors.push(error.message));
  const panel = page.locator('easy-hass-panel'), dialog = panel.getByRole('dialog');
  const title = panel.locator('#settings-title'), more = panel.locator('[data-tab="more"]');
  const rows = panel.locator('[data-settings-area-row]'), orderError = panel.locator('#settings-order-error');
  const edit = id => panel.locator(`[data-settings-area="${id}"]`);
  const handle = id => panel.locator(`[data-settings-drag="${id}"]`);
  const row = id => panel.locator(`[data-settings-area-row="${id}"]`);
  const registryOrder = async () => ids(await ha.call('config/area_registry/list'));
  const listOrder = () => rows.evaluateAll(items => items.map(item => item.dataset.settingsAreaRow));
  // The sorter intentionally keeps captured DOM nodes stable and previews with
  // transforms. Read their painted positions while a gesture is still held.
  const visualOrder = () => rows.evaluateAll(items => items.map(item => ({ id: item.dataset.settingsAreaRow, top: item.getBoundingClientRect().top }))
    .sort((a, b) => a.top - b.top).map(item => item.id));
  const homeOrder = () => panel.locator('[data-room-card]').evaluateAll(items => items.map(item => item.dataset.roomCard)
    .filter(id => id !== '__easy_hass_unassigned__'));
  const screenshot = async name => {
    const path = `test-results/room-order-${name}.png`; await page.screenshot({ path }); report.screenshots.push(path);
  };
  const dismiss = async () => {
    for (let count = 0; count < 7 && await dialog.count(); count++) await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  };
  const openRooms = async () => {
    if (await dialog.count()) await dismiss();
    await more.click(); await panel.locator('[data-settings-page="settings"]').click();
    await panel.locator('[data-settings-page="rooms"]').click(); await expect(title).toHaveText('Räume');
  };
  const assertOrder = async expected => {
    await expect.poll(registryOrder).toEqual(expected);
    await expect.poll(listOrder).toEqual(expected);
    await expect.poll(visualOrder).toEqual(expected);
    await expect.poll(homeOrder).toEqual(expected);
    await expect(panel.locator('.settings-form')).toHaveCount(0);
  };
  const center = async locator => {
    const box = await locator.boundingBox(); assert.ok(box, 'Drag target is visible');
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const touch = async (type, x, y) => {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: ['touchEnd', 'touchCancel'].includes(type) ? [] : [{ x, y }] });
    activeTouch = !['touchEnd', 'touchCancel'].includes(type);
  };
  const beginMouseMove = async (fromId, toId) => {
    await handle(fromId).scrollIntoViewIfNeeded();
    const start = await center(handle(fromId)), target = await row(toId).boundingBox();
    assert.ok(target, 'Target row exists');
    const y = target.y + target.height * (target.y > start.y ? .75 : .25);
    await page.mouse.move(start.x, start.y); await page.mouse.down(); activeMouse = true;
    await page.mouse.move(start.x, y, { steps: 12 });
  };
  const endMouse = async () => { await page.mouse.up(); activeMouse = false; };
  const beginTouchMove = async (fromId, toId) => {
    await handle(fromId).scrollIntoViewIfNeeded();
    const start = await center(handle(fromId)), target = await row(toId).boundingBox();
    assert.ok(target, 'Touch target row exists');
    const y = target.y + target.height * (target.y > start.y ? .75 : .25);
    await touch('touchStart', start.x, start.y);
    for (let step = 1; step <= 12; step++) await touch('touchMove', start.x, start.y + (y - start.y) * step / 12);
  };
  appearance = await panel.evaluate(el => ({ key: el._themeKey(), value: localStorage.getItem(el._themeKey()) }));
  await panel.evaluate(el => { localStorage.setItem(el._themeKey(), 'light'); el._applyTheme(); });

  await check('Settings exposes separate accessible drag handles; a handle click does not open room editing', async () => {
    await openRooms(); await assertOrder(ids(initialAreas));
    for (const area of initialAreas) {
      await expect(edit(area.area_id)).toContainText(area.name);
      await expect(handle(area.area_id)).toBeEnabled();
      await expect(handle(area.area_id)).toHaveAccessibleName(new RegExp(area.name));
      const box = await handle(area.area_id).boundingBox(), editBox = await edit(area.area_id).boundingBox();
      const arrowBox = await edit(area.area_id).locator('svg').last().boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, 'Reordering has a touch-size handle');
      assert.ok(box.x + box.width <= editBox.x + 1, 'The drag handle sits to the left of the room edit control');
      assert.ok(arrowBox.x > editBox.x + editBox.width / 2 && Math.abs(arrowBox.x + arrowBox.width - editBox.x - editBox.width) <= 2,
        'The edit arrow sits at the right edge');
    }
    await handle(initialAreas[0].area_id).click(); await expect(title).toHaveText('Räume');
    await expect(panel.locator('.settings-form')).toHaveCount(0); assert.deepEqual(await registryOrder(), ids(initialAreas));
    await edit(initialAreas[0].area_id).click(); await expect(panel.locator('#settings-room-name')).toHaveValue(initialAreas[0].name);
    await panel.locator('[data-settings-back]').click(); await expect(title).toHaveText('Räume');
    await screenshot('handles-light');
  });

  await check('Mouse drag previews a new order, commits once on drop and keeps settings plus home in sync', async () => {
    const before = await registryOrder(), expected = moved(before, 0, before.length - 1), eventsBefore = registryReorders.length;
    await beginMouseMove(before[0], before.at(-1));
    await expect.poll(visualOrder).toEqual(expected);
    assert.deepEqual(await registryOrder(), before, 'Moving a held row does not save early');
    await expect(panel.locator('.settings-form')).toHaveCount(0); await screenshot('mouse-drag');
    await endMouse(); await assertOrder(expected);
    await expect.poll(() => registryReorders.length).toBe(eventsBefore + 1);
    assert.deepEqual(registryReorders.at(-1), { action: 'reorder', area_id: null });
  });

  await check('The native HA order persists after a full reload and is used on the home screen', async () => {
    const expected = await registryOrder();
    await page.reload(); await panel.locator('.room-card').first().waitFor({ timeout: 30000 });
    await expect.poll(homeOrder).toEqual(expected); await openRooms(); await assertOrder(expected);
  });

  await check('A real touch drag reorders rooms without opening their editor or invoking device services', async () => {
    const before = await registryOrder(), expected = moved(before, before.length - 1, 0);
    await beginTouchMove(before.at(-1), before[0]); await expect.poll(visualOrder).toEqual(expected);
    assert.deepEqual(await registryOrder(), before, 'A held touch does not commit early');
    await touch('touchEnd'); await assertOrder(expected);
    await expect(panel.locator('.settings-form')).toHaveCount(0);
  });

  await check('Keyboard pickup, arrow movement and drop preserve focus and announce the order', async () => {
    const before = await registryOrder(), source = before[2], expected = moved(before, 2, 0);
    await handle(source).focus(); await page.keyboard.press('Space');
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
    await expect.poll(visualOrder).toEqual(expected); assert.deepEqual(await registryOrder(), before);
    await expect(handle(source)).toBeFocused();
    await expect(panel.locator('#settings-order-status')).not.toHaveText('');
    await page.keyboard.press('Enter'); await assertOrder(expected); await expect(handle(source)).toBeFocused();
  });

  await check('Switching from a keyboard drag to another pointer handle cancels the old draft without saving it', async () => {
    const before = await registryOrder(), eventsBefore = registryReorders.length, [first, second] = before;
    await handle(first).focus(); await page.keyboard.press('Space'); await page.keyboard.press('ArrowDown');
    await expect.poll(visualOrder).toEqual(moved(before, 0, 1));
    assert.deepEqual(await registryOrder(), before);
    await handle(second).click();
    await assertOrder(before); await expect(handle(second)).toBeFocused();
    await handle(second).press('Space'); await page.keyboard.press('ArrowUp');
    await expect.poll(visualOrder).toEqual(moved(before, 1, 0));
    assert.deepEqual(await registryOrder(), before);
    await page.keyboard.press('Escape'); await assertOrder(before);
    assert.equal(registryReorders.length, eventsBefore, 'Changing input method never commits the previous keyboard draft');
  });

  await check('Escape, touch cancellation and viewport resize restore the preview without saving a different order', async () => {
    const before = await registryOrder(), eventsBefore = registryReorders.length;
    await beginMouseMove(before[0], before.at(-1)); await expect.poll(visualOrder).not.toEqual(before);
    await page.keyboard.press('Escape'); await endMouse(); await assertOrder(before);
    await beginTouchMove(before.at(-1), before[0]); await expect.poll(visualOrder).not.toEqual(before);
    await touch('touchCancel'); await assertOrder(before);
    await handle(before[0]).focus(); await page.keyboard.press('Enter'); await page.keyboard.press('End');
    await expect.poll(visualOrder).not.toEqual(before); await page.keyboard.press('Escape'); await assertOrder(before);
    await beginMouseMove(before[0], before.at(-1)); await expect.poll(visualOrder).not.toEqual(before);
    await page.setViewportSize({ width: 360, height: 780 });
    // Chromium applies the emulated viewport before delivering window.resize.
    // Keep holding until the UI has actually processed that resize cancellation.
    await expect(panel.locator('.settings-list.is-reordering')).toHaveCount(0);
    await expect.poll(visualOrder).toEqual(before); await endMouse(); await assertOrder(before);
    await page.setViewportSize({ width: 390, height: 852 }); await assertOrder(before);
    assert.equal(registryReorders.length, eventsBefore, 'All cancelled gestures avoid the HA reorder command');
  });

  await check('A rejected save restores the previous order and exposes an accessible error', async () => {
    const before = await registryOrder(), eventsBefore = registryReorders.length;
    await panel.evaluate(el => {
      const hass = el.hass, original = hass.callWS;
      const test = window.__roomOrderFailure = { hass, original, calls: [], reject: null };
      hass.callWS = function (message) {
        if (message.type === 'config/area_registry/reorder') {
          test.calls.push({ type: message.type, area_ids: [...message.area_ids] });
          return new Promise((resolve, reject) => { test.reject = reject; });
        }
        return original.call(this, message);
      };
    });
    try {
      await beginMouseMove(before[0], before.at(-1)); await endMouse();
      await expect.poll(() => page.evaluate(() => window.__roomOrderFailure.calls.length)).toBe(1);
      assert.deepEqual(await registryOrder(), before, 'The failing browser-only command never reaches HA');
      await page.evaluate(() => {
        const test = window.__roomOrderFailure;
        test.hass.callWS = test.original; test.reject(new Error('Test: Reihenfolge konnte nicht gespeichert werden.')); test.reject = null;
      });
      await assertOrder(before);
      await expect(orderError).toHaveAttribute('role', 'alert'); await expect(orderError).toBeVisible();
      await expect(orderError).toContainText(/nicht|fehler|erneut/i);
      await expect(handle(before[0])).toBeEnabled();
      assert.equal(registryReorders.length, eventsBefore);
      await screenshot('save-error');
    } finally {
      await page.evaluate(() => {
        const test = window.__roomOrderFailure;
        if (test) { test.hass.callWS = test.original; test.reject?.(new Error('Test: rejected order cancelled.')); delete window.__roomOrderFailure; }
      });
    }
  });

  await check('A long room list autoscrolls during dragging and cancellation preserves its order', async () => {
    for (let index = 1; index <= 9; index++) {
      const name = `Easy-Hass Test Order ${suffix} ${String(index).padStart(2, '0')}`;
      const area = await ha.call('config/area_registry/create', { name });
      assert.ok(area.area_id && !initialAreas.some(original => original.area_id === area.area_id));
      temporaryAreas.set(area.area_id, name);
    }
    await openRooms(); const before = await registryOrder(); await assertOrder(before);
    await page.setViewportSize({ width: 320, height: 568 });
    await panel.evaluate(el => { localStorage.setItem(el._themeKey(), 'dark'); el._applyTheme(); });
    await handle(before[0]).scrollIntoViewIfNeeded();
    const scrollBefore = await dialog.evaluate(el => el.scrollTop), start = await center(handle(before[0]));
    const sheet = await dialog.boundingBox(); assert.ok(sheet && await dialog.evaluate(el => el.scrollHeight > el.clientHeight));
    await page.mouse.move(start.x, start.y); await page.mouse.down(); activeMouse = true;
    await page.mouse.move(start.x, sheet.y + sheet.height - 16, { steps: 10 });
    await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBeGreaterThan(scrollBefore + 40);
    await screenshot('long-list-dark');
    await page.keyboard.press('Escape'); await endMouse(); await assertOrder(before);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 390, height: 852 });
  });

  await check('Reordering changes no room properties, devices, entity assignments or fixture states', async () => {
    const remaining = (await ha.call('config/area_registry/list')).filter(area => !temporaryAreas.has(area.area_id));
    assert.deepEqual(sorted(remaining, 'area_id'), sorted(initialAreas, 'area_id'));
    assert.deepEqual(sorted(await ha.call('config/device_registry/list'), 'id'), sorted(initialDevices, 'id'));
    assert.deepEqual(sorted(await ha.call('config/entity_registry/list'), 'entity_id'), sorted(initialEntities, 'entity_id'));
    assert.equal(fingerprint((await ha.call('get_states')).filter(state => fixtureIds.has(state.entity_id))), initialStates);
    assert.deepEqual(serviceCalls, []); assert.deepEqual(report.errors, []);
  });
} catch (error) {
  failure = error;
  if (!report.results.some(result => !result.pass)) report.errors.push(error.stack || String(error));
  if (page) await page.screenshot({ path: 'test-results/room-order-failure.png' }).catch(() => {});
} finally {
  const cleanup = async run => { try { await run(); } catch (error) { report.errors.push(`Cleanup: ${error.message}`); } };
  if (activeTouch) await cleanup(() => cdp?.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }));
  if (activeMouse && page) await cleanup(async () => { await page.keyboard.press('Escape'); await page.mouse.up(); });
  if (page && appearance) await cleanup(() => page.locator('easy-hass-panel').evaluate((el, saved) => {
    if (saved.value === null) localStorage.removeItem(saved.key); else localStorage.setItem(saved.key, saved.value);
    el._applyTheme();
  }, appearance));
  if (browser) await cleanup(() => browser.close());
  if (ha && initialAreas) await cleanup(async () => {
    const areas = await ha.call('config/area_registry/list'), deletedAreaIds = [];
    for (const [id, name] of temporaryAreas) {
      const own = areas.find(area => area.area_id === id);
      if (!own) continue;
      assert.ok(own.name === name && name.startsWith('Easy-Hass Test Order ') && !initialAreas.some(area => area.area_id === id),
        'Only delete this run’s exact owned temporary areas');
      await ha.call('config/area_registry/delete', { area_id: id }); deletedAreaIds.push(id);
    }
    const remaining = await ha.call('config/area_registry/list');
    assert.deepEqual(ids(remaining).sort(), ids(initialAreas).sort(), 'Do not overwrite an order if external areas changed');
    assert.deepEqual(sorted(remaining, 'area_id'), sorted(initialAreas, 'area_id'), 'Original area properties must be preserved');
    if (JSON.stringify(ids(remaining)) !== JSON.stringify(ids(initialAreas))) {
      await ha.call('config/area_registry/reorder', { area_ids: ids(initialAreas) });
    }
    assert.deepEqual(await ha.call('config/area_registry/list'), initialAreas, 'The exact original HA order and properties are restored');
    report.cleanup = { originalOrderRestored: true, originalAreasPreserved: true, deletedAreaIds };
  });
  ha?.close();
  report.haServiceCalls = serviceCalls.length; report.registryReorders = registryReorders.length;
  await writeFile('test-results/browser-room-order.json', `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.results.filter(result => result.pass).length, report: 'test-results/browser-room-order.json', haServiceCalls: serviceCalls.length }));
if (failure) throw failure;
if (report.errors.length) throw new Error('Room order checks reported browser or cleanup errors; see report');
