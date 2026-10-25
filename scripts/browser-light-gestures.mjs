/** Light-body tap/drag/scroll arbitration in native Chromium; HA commands are browser-only spies. */
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { localBrowser } from './browser-login.mjs';
import { LocalHA } from './ha-client.mjs';

const report = { at: new Date().toISOString(), results: [], errors: [] }, actualCalls = [];
let ha, browser, context, page, cdp, activeTouch = false, failure;
const check = async (name, run) => {
  try { await run(); report.results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.results.push({ name, pass: false, error: error.stack || String(error) }); throw error; }
};
await mkdir('test-results', { recursive: true });
try {
  ha = await LocalHA.open();
  const registry = await ha.call('config/entity_registry/list'), devices = await ha.call('config/device_registry/list');
  const fixture = suffix => {
    const item = registry.find(entity => entity.unique_id === `easy_hass_test_${suffix}`);
    assert.ok(item, `Missing isolated fixture ${suffix}`);
    return { ...item, room: item.area_id || devices.find(device => device.id === item.device_id)?.area_id };
  };
  const light = fixture('living_light'), binary = fixture('living_onoff');
  const before = (await ha.call('get_states')).filter(entity => [light.entity_id, binary.entity_id].includes(entity.entity_id));
  await ha.call('subscribe_events', { event_type: 'call_service' }, event => actualCalls.push(event.data));
  ({ browser, context, page } = await localBrowser({ hasTouch: true, reducedMotion: 'reduce' }));
  cdp = await context.newCDPSession(page);
  page.on('pageerror', error => report.errors.push(error.message));
  const panel = page.locator('easy-hass-panel'), room = panel.locator('.room-detail[data-current-room]');
  report.revision = await panel.evaluate(el => el.shadowRoot.querySelector('link[rel=stylesheet]').href.match(/builds\/([^/]+)/)?.[1]);
  await panel.locator(`[data-open-room="${light.room}"]`).click();
  await expect(room).toHaveAttribute('data-room-detail', light.room);
  const row = id => room.locator(`[data-inline-control="${id}"]`);
  const body = id => row(id).locator(`[data-inline-details="${id}"]`);
  const range = id => row(id).locator(`[data-inline-range="${id}"]`);
  const icon = id => row(id).locator(`[data-inline-toggle="${id}"]`);
  const dialog = page.locator('ha-more-info-dialog').getByRole('dialog');
  await panel.evaluate((el, { lightId, binaryId }) => {
    window.__lightGestureProbe = { original: el.hass, calls: [], details: [] };
    const saved = el.hass, states = { ...saved.states };
    states[lightId] = { ...states[lightId], state: 'on', attributes: { ...states[lightId].attributes, brightness: 153 } };
    states[binaryId] = { ...states[binaryId], state: 'off' };
    el.hass = { ...saved, states, callService: (...args) => { window.__lightGestureProbe.calls.push(args); return Promise.resolve(); } };
    el.addEventListener('hass-more-info', event => window.__lightGestureProbe.details.push(event.detail.entityId));
  }, { lightId: light.entity_id, binaryId: binary.entity_id });
  const reset = () => page.evaluate(() => { window.__lightGestureProbe.calls = []; window.__lightGestureProbe.details = []; });
  const observations = () => page.evaluate(() => ({ calls: window.__lightGestureProbe.calls, details: window.__lightGestureProbe.details }));
  const touch = async (type, point) => {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: ['touchEnd', 'touchCancel'].includes(type) ? [] : [point] });
    activeTouch = !['touchEnd', 'touchCancel'].includes(type);
  };
  const down = async (mode, point) => {
    if (mode === 'touch') await touch('touchStart', point);
    else { await page.mouse.move(point.x, point.y); await page.mouse.down(); }
  };
  const move = (mode, point) => mode === 'touch' ? touch('touchMove', point) : page.mouse.move(point.x, point.y, { steps: 4 });
  const up = mode => mode === 'touch' ? touch('touchEnd') : page.mouse.up();
  const geometry = async id => {
    await body(id).scrollIntoViewIfNeeded(); const box = await body(id).boundingBox();
    return { box, point: { x: box.x + box.width * .5, y: box.y + box.height / 2 } };
  };
  const noActions = async () => {
    await page.waitForTimeout(90);
    assert.deepEqual(await observations(), { calls: [], details: [] });
    await expect(dialog).not.toBeVisible();
    await expect(room).toHaveAttribute('data-room-detail', light.room);
    await expect(panel.locator('.adjust-bar')).toHaveCount(0);
  };
  const verifyDetails = async id => {
    await expect(dialog).toBeVisible({ timeout: 10000 });
    assert.deepEqual(await observations(), { calls: [], details: [id] });
    await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
    await expect(room).toHaveAttribute('data-room-detail', light.room);
  };
  const verifyCommand = async (id, service, value) => {
    await expect.poll(async () => (await observations()).calls.length).toBe(1);
    await page.waitForTimeout(90);
    const { calls, details } = await observations();
    assert.equal(calls.length, 1); assert.deepEqual(details, []);
    assert.equal(calls[0][0], 'light'); assert.equal(calls[0][1], service);
    assert.deepEqual(calls[0][2].entity_id, [id]);
    if (value !== undefined) assert.equal(calls[0][2].brightness_pct, value);
    await expect(dialog).not.toBeVisible();
    await expect(room).toHaveAttribute('data-room-detail', light.room);
  };

  await check('Mouse and native touch body taps open the exact light details with no device command', async () => {
    for (const id of [light.entity_id, binary.entity_id]) for (const mode of ['mouse', 'touch']) {
      await reset(); const { point } = await geometry(id);
      await down(mode, point); await expect(row(id)).not.toHaveClass(/is-adjusting/);
      await up(mode); await verifyDetails(id);
    }
    await expect(range(binary.entity_id)).toHaveCount(0);
    assert.equal(await range(light.entity_id).evaluate(el => getComputedStyle(el).pointerEvents), 'none');
  });

  await check('Horizontal mouse and native touch drags preview then commit exactly one targeted brightness without details', async () => {
    for (const [mode, fraction] of [['mouse', .28], ['touch', .82]]) {
      await reset(); const { box, point } = await geometry(light.entity_id);
      await down(mode, point); await expect(range(light.entity_id)).toHaveValue('60');
      await move(mode, { x: box.x + box.width * fraction, y: point.y });
      await expect(row(light.entity_id)).toHaveClass(/is-adjusting/);
      const value = Number(await range(light.entity_id).inputValue());
      assert.ok(Math.abs(value - fraction * 100) <= 1);
      await expect(row(light.entity_id).locator('.inline-value')).toHaveText(`${value} %`);
      assert.deepEqual(await observations(), { calls: [], details: [] });
      await up(mode); await verifyCommand(light.entity_id, 'turn_on', value);
      await expect(range(light.entity_id)).toHaveValue('60');
    }
    // A binary light has no hidden dimmer; a horizontal gesture must not become a details tap.
    await reset(); const { point } = await geometry(binary.entity_id);
    await down('touch', point); await move('touch', { x: point.x - 70, y: point.y }); await up('touch');
    await noActions(); await expect(range(binary.entity_id)).toHaveCount(0);
  });

  await check('Vertical mouse and native touch over the light body scroll the same room without a value, details or route change', async () => {
    await panel.evaluate(el => {
      const style = document.createElement('style'); style.id = 'test-light-body-scroll';
      style.textContent = '.room-detail[data-current-room]::after { content:"";display:block;height:900px; }';
      el.shadowRoot.append(style);
    });
    try {
      report.scrollDelta = {};
      for (const mode of ['mouse', 'touch']) {
        await room.evaluate(el => { el.scrollTop = 0; }); await reset();
        const { point } = await geometry(light.entity_id), scrollBefore = await room.evaluate(el => el.scrollTop);
        await down(mode, point);
        for (const distance of [35, 75, 125, 175]) { await move(mode, { x: point.x, y: point.y - distance }); await page.waitForTimeout(35); }
        await up(mode);
        await expect.poll(() => room.evaluate(el => el.scrollTop)).toBeGreaterThan(scrollBefore + 30);
        await expect(range(light.entity_id)).toHaveValue('60'); await noActions();
        report.scrollDelta[mode] = await room.evaluate(el => el.scrollTop) - scrollBefore;
      }
    } finally {
      await panel.evaluate(el => el.shadowRoot.querySelector('#test-light-body-scroll')?.remove());
      await room.evaluate(el => { el.scrollTop = 0; });
    }
  });

  await check('The separate icon sends one toggle and never opens details', async () => {
    for (const [mode, id, service] of [['mouse', light.entity_id, 'turn_off'], ['touch', binary.entity_id, 'turn_on']]) {
      await reset(); await icon(id).scrollIntoViewIfNeeded(); const box = await icon(id).boundingBox();
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await down(mode, point); await up(mode); await verifyCommand(id, service);
    }
  });

  await check('Escape and native touchcancel discard a drag and suppress its follow-up click without disabling the next tap', async () => {
    for (const mode of ['mouse', 'touch']) {
      await reset(); const { box, point } = await geometry(light.entity_id);
      await down(mode, point); await move(mode, { x: box.x + box.width * .85, y: point.y });
      await expect(row(light.entity_id)).toHaveClass(/is-adjusting/);
      if (mode === 'mouse') { await page.keyboard.press('Escape'); await page.mouse.up(); }
      else await touch('touchCancel');
      await expect(range(light.entity_id)).toHaveValue('60'); await noActions();
      await body(light.entity_id).click(); await verifyDetails(light.entity_id);
    }
  });

  await check('Native keyboard range commits only on keyup and Enter on the body opens details', async () => {
    for (const [key, value, label, service] of [['Home', 0, 'Aus', 'turn_off'], ['End', 100, 'An', 'turn_on']]) {
      await reset(); await range(light.entity_id).focus(); await page.keyboard.down(key);
      await expect(range(light.entity_id)).toHaveValue(String(value));
      await expect(row(light.entity_id).locator('.inline-value')).toHaveText(label);
      assert.deepEqual(await observations(), { calls: [], details: [] });
      await page.keyboard.up(key); await verifyCommand(light.entity_id, service, value || undefined);
    }
    await reset(); await body(light.entity_id).focus(); await page.keyboard.press('Enter'); await verifyDetails(light.entity_id);
  });
  assert.deepEqual(actualCalls, [], 'No service call reached HA');
  const after = (await ha.call('get_states')).filter(entity => before.some(saved => saved.entity_id === entity.entity_id));
  assert.deepEqual(after.map(entity => [entity.entity_id, entity.last_updated]), before.map(entity => [entity.entity_id, entity.last_updated]));
  report.haServiceCalls = actualCalls.length;
  assert.deepEqual(report.errors, []);
} catch (error) {
  failure = error;
  if (page) await page.screenshot({ path: 'test-results/light-gestures-failure.png' }).catch(() => {});
} finally {
  const cleanup = async run => { try { await run(); } catch (error) { report.errors.push(`Cleanup: ${error.message}`); } };
  if (page) {
    if (activeTouch && cdp) await cleanup(() => cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }));
    await cleanup(() => page.keyboard.press('Escape')); await cleanup(() => page.mouse.up());
    await cleanup(() => page.locator('easy-hass-panel').evaluate(el => {
      el._inlineControls?.cancel(); el.shadowRoot.querySelector('#test-light-body-scroll')?.remove();
      if (window.__lightGestureProbe?.original) el.hass = window.__lightGestureProbe.original;
    }));
  }
  if (browser) await cleanup(() => browser.close()); ha?.close();
  await writeFile('test-results/browser-light-gestures.json', `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.results.filter(result => result.pass).length, report: 'test-results/browser-light-gestures.json' }));
if (failure) throw failure;
if (report.errors.length) throw new Error('Light-gesture checks reported browser or cleanup errors');
