/** Focused inline-control edge checks; all service calls are intercepted in this isolated browser. */
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { localBrowser } from './browser-login.mjs';
import { LocalHA } from './ha-client.mjs';

const report = { at: new Date().toISOString(), results: [], errors: [] };
let ha, browser, page, failure;
const events = [];
const check = async (name, run) => {
  try { await run(); report.results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.results.push({ name, pass: false, error: error.stack || String(error) }); throw error; }
};
await mkdir('test-results', { recursive: true });
try {
  ha = await LocalHA.open();
  const registry = await ha.call('config/entity_registry/list'), devices = await ha.call('config/device_registry/list');
  const light = registry.find(entity => entity.unique_id === 'easy_hass_test_living_light');
  assert.ok(light, 'Only the isolated local light fixture is used');
  const roomId = light.area_id || devices.find(device => device.id === light.device_id)?.area_id;
  const before = (await ha.call('get_states')).find(entity => entity.entity_id === light.entity_id);
  await ha.call('subscribe_events', { event_type: 'call_service' }, event => events.push(event.data));
  ({ browser, page } = await localBrowser({ reducedMotion: 'reduce' }));
  page.on('pageerror', error => report.errors.push(error.message));
  const panel = page.locator('easy-hass-panel');
  report.revision = await panel.evaluate(el => el.shadowRoot.querySelector('link[rel=stylesheet]')?.href.match(/builds\/([^/]+)/)?.[1]);
  await page.locator(`[data-open-room="${roomId}"]`).click();
  const room = panel.locator('.room-detail[data-current-room]');
  await expect(room).toHaveAttribute('data-room-detail', roomId);
  await expect(panel.locator('.room-transition-ghost')).toHaveCount(0);
  const range = room.locator(`[data-inline-range="${light.entity_id}"]`), icon = room.locator(`[data-inline-toggle="${light.entity_id}"]`);
  const row = room.locator(`[data-inline-control="${light.entity_id}"]`);
  const body = row.locator('[data-inline-details]');
  await panel.evaluate(el => {
    window.__inlineEdge = { original: el.hass, calls: [], tabs: [] };
    el.hass = { ...el.hass, callService: (...args) => {
      window.__inlineEdge.calls.push(args);
      return new Promise(resolve => { window.__inlineEdge.resolve = resolve; });
    } };
    el.shadowRoot.addEventListener('keydown', event => {
      if (event.key === 'Tab' && event.target.closest('.inline-control')) window.__inlineEdge.tabs.push(event.target.dataset.inlineRange ? 'range' : 'icon');
    });
  });
  const count = () => page.evaluate(() => window.__inlineEdge.calls.length);
  const insideStage = () => panel.evaluate(el => !!el.shadowRoot.activeElement?.closest('.room-stage'));

  await check('Tab from inline range and icon reaches the room focus trap and cancels an uncommitted key draft', async () => {
    const original = await range.inputValue();
    await range.focus(); await page.keyboard.down(original === '100' ? 'Home' : 'End');
    await expect(row).toHaveClass(/is-adjusting/);
    await page.keyboard.press('Tab');
    await page.keyboard.up(original === '100' ? 'Home' : 'End');
    await expect(row).not.toHaveClass(/is-adjusting/);
    await expect(range).toHaveValue(original);
    assert.equal(await insideStage(), true);
    await icon.focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await insideStage(), true);
    assert.deepEqual(await page.evaluate(() => window.__inlineEdge.tabs), ['range', 'icon']);
    // Exercise the actual forward and backward boundary wrap, not just bubbling.
    const boundary = async last => panel.evaluate((el, last) => {
      const nodes = [...el.shadowRoot.querySelectorAll('.room-stage button, .room-stage a, .room-stage input')].filter(node => !node.disabled && !node.closest('[inert]'));
      (last ? nodes.at(-1) : nodes[0]).focus();
    }, last);
    await boundary(true); await page.keyboard.press('Tab');
    assert.equal(await panel.evaluate(el => el.shadowRoot.activeElement === [...el.shadowRoot.querySelectorAll('.room-stage button, .room-stage a, .room-stage input')].filter(node => !node.disabled && !node.closest('[inert]'))[0]), true);
    await page.keyboard.press('Shift+Tab'); assert.equal(await insideStage(), true);
    assert.equal(await count(), 0);
  });

  await check('Canceling the local session keeps a pending HA target disabled and blocks a second command until completion', async () => {
    await range.focus(); await page.keyboard.press((await range.inputValue()) === '100' ? 'Home' : 'End');
    await expect.poll(count).toBe(1);
    await expect(row).toHaveClass(/is-pending/);
    await page.keyboard.press('Escape');
    await expect(range).toBeDisabled(); await expect(icon).toBeDisabled(); await expect(body).toBeDisabled();
    await expect(row).toHaveAttribute('aria-busy', 'true');
    assert.equal(await panel.evaluate(el => el._inlineControls.active), false);
    // Re-enable only the isolated DOM controls to exercise the controller's independent pending guard.
    await range.evaluate(el => { el.disabled = false; });
    await icon.evaluate(el => { el.disabled = false; });
    await body.evaluate(el => { el.disabled = false; });
    await body.scrollIntoViewIfNeeded();
    const box = await body.boundingBox();
    await page.mouse.move(box.x + box.width * .5, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .8, box.y + box.height / 2); await page.mouse.up();
    await icon.click();
    assert.equal(await count(), 1);
    assert.equal(await panel.evaluate(el => el._inlineControls.active), false);
    await panel.evaluate(el => { el._lastRoomMarkup = null; el._update(); });
    await expect(range).toBeDisabled(); await expect(icon).toBeDisabled(); await expect(body).toBeDisabled();
    await page.evaluate(() => { window.__inlineEdge.resolve(); window.__inlineEdge.resolve = null; });
    await expect(range).toBeEnabled(); await expect(icon).toBeEnabled();
    await expect(row).not.toHaveClass(/is-pending/);
    assert.equal(await count(), 1);
  });

  await check('An active native room drag prevents keyboard or icon input from starting an inline adjustment', async () => {
    await room.evaluate(el => { el.scrollTop = 0; });
    const photo = await room.locator('.detail-photo').boundingBox();
    assert.ok(photo);
    const x = photo.x + photo.width * .7, y = photo.y + 70;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 20, y);
    assert.equal(await panel.evaluate(el => !!el._roomDrag?.locked), true);
    const original = await range.inputValue();
    await range.focus(); await page.keyboard.press(original === '100' ? 'Home' : 'End');
    await icon.evaluate(el => el.click());
    await expect(range).toHaveValue(original);
    assert.equal(await panel.evaluate(el => el._inlineControls.active), false);
    assert.equal(await count(), 1);
    await panel.evaluate(el => el._cancelRoomSwipe(false)); await page.mouse.up();
    await expect(room).toHaveAttribute('data-room-detail', roomId);
  });
  await page.waitForTimeout(80);
  assert.deepEqual(events, [], 'No HA service crossed the browser-only spy');
  const after = (await ha.call('get_states')).find(entity => entity.entity_id === light.entity_id);
  assert.equal(after.last_updated, before.last_updated);
  report.haServiceCalls = events.length;
  assert.deepEqual(report.errors, []);
} catch (error) {
  failure = error;
  if (page) await page.screenshot({ path: 'test-results/inline-edges-failure.png' }).catch(() => {});
} finally {
  const cleanup = async fn => { try { await fn(); } catch (error) { report.errors.push(`Cleanup: ${error.message}`); } };
  if (page) {
    await cleanup(() => page.locator('easy-hass-panel').evaluate(el => {
      el._inlineControls?.cancel(); el._cancelRoomSwipe(false);
      window.__inlineEdge?.resolve?.();
      if (window.__inlineEdge?.original) el.hass = window.__inlineEdge.original;
    }));
    await cleanup(() => page.mouse.up());
  }
  if (browser) await cleanup(() => browser.close()); ha?.close();
  await writeFile('test-results/browser-inline-edges.json', `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.results.filter(result => result.pass).length, report: 'test-results/browser-inline-edges.json' }));
if (failure) throw failure;
if (report.errors.length) throw new Error('Inline edge checks reported browser or cleanup errors');
