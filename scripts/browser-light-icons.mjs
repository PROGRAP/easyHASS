/** Dynamic bulb visuals in the actual local panel; service calls stay inside this browser. */
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { localBrowser } from './browser-login.mjs';
import { LocalHA } from './ha-client.mjs';

const report = { at: new Date().toISOString(), results: [], errors: [] }, events = [];
let ha, browser, page, appearance, failure;
const check = async (name, run) => {
  try { await run(); report.results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.results.push({ name, pass: false, error: error.stack || String(error) }); throw error; }
};
await mkdir('test-results', { recursive: true });
try {
  ha = await LocalHA.open();
  const registry = await ha.call('config/entity_registry/list'), devices = await ha.call('config/device_registry/list');
  const fixture = suffix => {
    const entity = registry.find(item => item.unique_id === `easy_hass_test_${suffix}`);
    assert.ok(entity, `Missing isolated fixture ${suffix}`);
    return { ...entity, room: entity.area_id || devices.find(device => device.id === entity.device_id)?.area_id };
  };
  const light = fixture('living_light'), binary = fixture('living_onoff'), cover = fixture('living_cover');
  const before = (await ha.call('get_states')).filter(entity => [light.entity_id, binary.entity_id, cover.entity_id].includes(entity.entity_id));
  await ha.call('subscribe_events', { event_type: 'call_service' }, event => events.push(event.data));
  ({ browser, page } = await localBrowser({ reducedMotion: 'reduce' }));
  page.on('pageerror', error => report.errors.push(error.message));
  const panel = page.locator('easy-hass-panel'), room = panel.locator('.room-detail[data-current-room]');
  const home = panel.locator(`[data-room-card="${light.room}"] [data-control="light"]`);
  const row = id => room.locator(`[data-inline-control="${id}"]`);
  const range = id => row(id).locator('[data-inline-range]');
  const glyph = id => row(id).locator('.inline-icon svg');
  report.revision = await panel.evaluate(el => el.shadowRoot.querySelector('link[rel=stylesheet]').href.match(/builds\/([^/]+)/)?.[1]);
  appearance = await panel.evaluate(el => ({ key: el._themeKey(), value: localStorage.getItem(el._themeKey()) }));
  await panel.evaluate(el => {
    window.__bulbProbe = { original: el.hass, states: { ...el.hass.states }, calls: [] };
    window.__bulbProbe.spy = (...args) => { window.__bulbProbe.calls.push(args); return Promise.resolve(); };
  });
  const stage = async (lightState = 'on', brightness = 60, binaryState = 'off', position = 65) => panel.evaluate((el, values) => {
    const probe = window.__bulbProbe;
    for (const [id, state, attributes] of values) {
      const original = probe.original.states[id];
      const attrs = { ...original.attributes, ...attributes };
      if (attrs.brightness === null) delete attrs.brightness;
      probe.states[id] = { ...original, state, attributes: attrs };
    }
    el.hass = { ...probe.original, states: { ...probe.states }, callService: probe.spy };
  }, [[light.entity_id, lightState, { brightness: brightness === null ? null : Math.round(brightness / 100 * 255) }],
    [binary.entity_id, binaryState, {}], [cover.entity_id, position ? 'open' : 'closed', { current_position: position }]]);
  const calls = () => page.evaluate(() => window.__bulbProbe.calls);
  const level = locator => locator.evaluate(el => Number(el.style.getPropertyValue('--light-level')));
  const svg = locator => locator.evaluate(el => el.outerHTML);
  const expectLevel = (locator, value) => expect.poll(() => level(locator)).toBe(value);
  const expectRays = async (locator, expected) => {
    await expect(locator.locator('.light-bulb-ray')).toHaveCount(5);
    await expect.poll(() => locator.evaluate((el, expected) => [...el.querySelectorAll('.light-bulb-ray')].every(ray => {
      const style = getComputedStyle(ray);
      return ray.getAttribute('pathLength') === '1' && Math.abs(Number(style.opacity) - expected) < .01
        && Math.abs(Number(style.strokeDashoffset.match(/-?\d+(?:\.\d+)?/)?.[0]) - (1 - expected)) < .01;
    }), expected)).toBe(true);
  };
  const open = async () => {
    await panel.locator(`[data-open-room="${light.room}"]`).click();
    await expect(room).toHaveAttribute('data-room-detail', light.room);
    await expect(panel.locator('.room-transition-ghost')).toHaveCount(0);
  };
  const close = async () => { await room.locator('[data-room-back]').click(); await expect(panel.locator('.room-stage')).toHaveCount(0); };
  const drag = async (id, fraction) => {
    await range(id).scrollIntoViewIfNeeded(); const rect = await range(id).boundingBox();
    await page.mouse.move(rect.x + rect.width * .5, rect.y + rect.height / 2); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width * fraction, rect.y + rect.height / 2, { steps: 4 });
    return Number(await range(id).inputValue());
  };

  await check('External off, full and unknown light values update home and inline icons; binary lights keep only on/off', async () => {
    for (const [state, value, expected] of [['off', 60, 0], ['on', 100, 1], ['on', null, 0]]) {
      await stage(state, value); await expectLevel(home.locator('.light-state-icon'), expected);
      await expectRays(home.locator('.light-state-icon'), expected);
      await open(); await expectLevel(glyph(light.entity_id), expected); await expectRays(glyph(light.entity_id), expected);
      await expect(range(binary.entity_id)).toHaveCount(0);
      await expectLevel(glyph(binary.entity_id), 0);
      if (value === null) await expect(row(light.entity_id).locator('.inline-value')).toHaveText('—');
      await stage(state, value, 'on'); await expectLevel(glyph(binary.entity_id), 1); await expectRays(glyph(binary.entity_id), 1);
      await expect(range(binary.entity_id)).toHaveCount(0);
      await close();
    }
    assert.equal((await calls()).length, 0);
  });

  await check('Home pointer and keyboard previews change bulb intensity immediately and cancel to the exact original icon', async () => {
    await stage('on', 60); const original = await svg(home.locator('svg'));
    await home.scrollIntoViewIfNeeded();
    const rect = await home.boundingBox(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 50, y, { steps: 4 });
    await expect(panel.locator('.adjust-bar')).toBeVisible();
    const value = Number((await panel.locator('#adjust-value').textContent()).replace(/\D/g, ''));
    assert.ok(value < 60); await expectLevel(panel.locator('#adjust-icon .light-state-icon'), value / 100);
    await expectRays(panel.locator('#adjust-icon .light-state-icon'), value / 100);
    assert.equal((await calls()).length, 0);
    await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(panel.locator('.adjust-bar')).toHaveCount(0);
    assert.equal(await svg(home.locator('svg')), original);
    await home.focus(); await page.keyboard.press('ArrowRight');
    await expect(panel.locator('#adjust-range')).toBeFocused();
    for (const [key, expected] of [['Home', 0], ['End', 1]]) {
      await page.keyboard.press(key); await expectLevel(panel.locator('#adjust-icon .light-state-icon'), expected);
      await expectRays(panel.locator('#adjust-icon .light-state-icon'), expected);
    }
    assert.equal((await calls()).length, 0);
    await page.keyboard.press('Escape'); await expect(panel.locator('.adjust-bar')).toHaveCount(0);
    assert.equal(await svg(home.locator('svg')), original);
  });

  await check('Inline mouse and key previews restore exact SVG/style on cancel and send only one command on release', async () => {
    await open(); const original = await svg(glyph(light.entity_id));
    const value = await drag(light.entity_id, .28);
    await expectLevel(glyph(light.entity_id), value / 100); await expectRays(glyph(light.entity_id), value / 100);
    assert.equal((await calls()).length, 0);
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(await svg(glyph(light.entity_id)), original);
    await range(light.entity_id).focus(); await page.keyboard.down('End');
    await expectLevel(glyph(light.entity_id), 1); await expectRays(glyph(light.entity_id), 1); assert.equal((await calls()).length, 0);
    await page.keyboard.press('Escape'); await page.keyboard.up('End');
    assert.equal(await svg(glyph(light.entity_id)), original);
    const committed = await drag(light.entity_id, .84);
    await expectLevel(glyph(light.entity_id), committed / 100); assert.equal((await calls()).length, 0);
    await page.mouse.up(); await expect.poll(async () => (await calls()).length).toBe(1);
    const [domain, service, data] = (await calls())[0];
    assert.equal(domain, 'light'); assert.equal(service, 'turn_on');
    assert.equal(data.brightness_pct, committed); assert.deepEqual(data.entity_id, [light.entity_id]);
    await expect(row(light.entity_id)).not.toHaveClass(/is-pending|is-adjusting/);
  });

  await check('Cover SVG still previews and restores on cancellation; bulb fill remains visible in both themes', async () => {
    const original = await svg(glyph(cover.entity_id));
    await drag(cover.entity_id, .25); assert.notEqual(await svg(glyph(cover.entity_id)), original);
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(await svg(glyph(cover.entity_id)), original);
    assert.equal((await calls()).length, 1);
    await stage('on', 70, 'on', 65);
    for (const theme of ['light', 'dark']) {
      await panel.evaluate((el, theme) => { localStorage.setItem(el._themeKey(), theme); el._applyTheme(); }, theme);
      await expectLevel(glyph(light.entity_id), .7); await expectRays(glyph(light.entity_id), .7);
      await page.waitForTimeout(150);
      const style = await glyph(light.entity_id).evaluate(el => ({ fill: getComputedStyle(el.querySelector('.light-bulb-fill')).opacity, glow: getComputedStyle(el.querySelector('.light-bulb-glow')).opacity }));
      assert.ok(Number(style.fill) > 0 && Number(style.glow) > 0);
      await room.evaluate(el => { el.scrollTop = 0; });
      await page.screenshot({ path: `test-results/light-icons-${theme}.png` });
    }
  });
  assert.deepEqual(events, [], 'All service commands stayed within the browser spy');
  const after = (await ha.call('get_states')).filter(entity => before.some(saved => saved.entity_id === entity.entity_id));
  assert.deepEqual(after.map(entity => [entity.entity_id, entity.last_updated]), before.map(entity => [entity.entity_id, entity.last_updated]));
  report.haServiceCalls = events.length;
  assert.deepEqual(report.errors, []);
} catch (error) {
  failure = error;
  if (page) await page.screenshot({ path: 'test-results/light-icons-failure.png' }).catch(() => {});
} finally {
  const cleanup = async run => { try { await run(); } catch (error) { report.errors.push(`Cleanup: ${error.message}`); } };
  if (page) {
    await cleanup(() => page.keyboard.press('Escape')); await cleanup(() => page.mouse.up());
    await cleanup(() => panelRestore(page, appearance));
  }
  if (browser) await cleanup(() => browser.close()); ha?.close();
  await writeFile('test-results/browser-light-icons.json', `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.results.filter(result => result.pass).length, report: 'test-results/browser-light-icons.json' }));
if (failure) throw failure;
if (report.errors.length) throw new Error('Bulb checks reported browser or cleanup errors');

async function panelRestore(page, appearance) {
  await page.locator('easy-hass-panel').evaluate((el, appearance) => {
    el._inlineControls?.cancel();
    if (window.__bulbProbe?.original) el.hass = window.__bulbProbe.original;
    if (appearance) {
      if (appearance.value === null) localStorage.removeItem(appearance.key); else localStorage.setItem(appearance.key, appearance.value);
      el._applyTheme();
    }
  }, appearance);
}
