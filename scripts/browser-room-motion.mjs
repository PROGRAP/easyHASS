/** Room-card motion and native touch arbitration in the actual local HA panel. */
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { localBrowser } from './browser-login.mjs';
import { LocalHA } from './ha-client.mjs';

const report = { at: new Date().toISOString(), results: [], errors: [], geometry: [] };
await mkdir('test-results', { recursive: true });
let ha, browser, context, page, cdp, initial, fixtures, appearance, failure, fixturesChanged = false, activeTouch = false;
const serviceEvents = [];
const check = async (name, run) => {
  try { await run(); report.results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.results.push({ name, pass: false, error: error.stack || String(error) }); throw error; }
};
const near = (actual, expected, message, tolerance = 1) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);

try {
  ha = await LocalHA.open();
  initial = new Map((await ha.call('get_states')).map(state => [state.entity_id, state]));
  const registry = await ha.call('config/entity_registry/list'), devices = await ha.call('config/device_registry/list');
  const fixture = suffix => {
    const entity = registry.find(item => item.unique_id === `easy_hass_test_${suffix}`);
    assert.ok(entity, `Missing isolated fixture ${suffix}`);
    return { ...entity, room: entity.area_id || devices.find(device => device.id === entity.device_id)?.area_id };
  };
  fixtures = { light: fixture('living_light'), binary: fixture('living_onoff'), cover: fixture('living_cover') };
  await ha.call('subscribe_events', { event_type: 'call_service' }, event => serviceEvents.push(event.data));
  ({ browser, context, page } = await localBrowser({ hasTouch: true, reducedMotion: 'no-preference' }));
  cdp = await context.newCDPSession(page);
  page.on('pageerror', error => report.errors.push(error.message));
  const panel = page.locator('easy-hass-panel');
  const stage = page.locator('.room-stage'), current = page.locator('.room-detail[data-current-room]');
  const card = id => page.locator(`[data-room-card="${id}"]`);
  const source = id => card(id).locator('[data-open-room]');
  const entityControl = id => current.locator(`[data-control][data-entity="${id}"]`);
  const selected = () => current.getAttribute('data-room-detail');
  const state = async id => (await ha.call('get_states')).find(entity => entity.entity_id === id);
  const service = (domain, name, id, data = {}) => ha.call('call_service', { domain, service: name, target: { entity_id: id }, service_data: data });
  const calls = id => serviceEvents.filter(event => {
    const ids = event.service_data?.entity_id ?? event.target?.entity_id ?? [];
    return (Array.isArray(ids) ? ids : [ids]).includes(id);
  });
  const roomIds = await page.locator('[data-room-card]').evaluateAll(nodes => nodes.map(node => node.dataset.roomCard));
  assert.ok(roomIds.length >= 3, 'Room pagination requires at least three actual HA areas');
  const first = roomIds[0], next = roomIds[1], last = roomIds.at(-1);
  appearance = await panel.evaluate(el => ({ key: el._themeKey(), value: localStorage.getItem(el._themeKey()) }));
  await panel.evaluate(el => { localStorage.setItem(el._themeKey(), 'light'); el._applyTheme(); });

  const installMotionProbe = () => {
    if (window.__roomNativeAnimate) return;
    window.__roomNativeAnimate = Element.prototype.animate;
    window.__roomFreeze = false; window.__roomAnimationCalls = [];
    Element.prototype.animate = function (...args) {
      const animation = window.__roomNativeAnimate.apply(this, args);
      if (this.getRootNode()?.host?.localName === 'easy-hass-panel') {
        window.__roomAnimationCalls.push({ classes: this.className, duration: animation.effect?.getTiming().duration });
        if (window.__roomFreeze) { animation.pause(); animation.currentTime = 0; }
      }
      return animation;
    };
  };
  await page.addInitScript(installMotionProbe); await page.evaluate(installMotionProbe);
  const freeze = value => page.evaluate(value => { window.__roomFreeze = value; }, value);
  const settledPosition = () => expect.poll(() => current.evaluate(el => {
    const viewport = el.closest('.room-viewport').getBoundingClientRect();
    return Math.abs(el.getBoundingClientRect().left - viewport.left) < 1;
  })).toBe(true);
  const settle = async () => {
    await expect(stage).toHaveCount(1);
    await expect(page.locator('.room-transition-ghost')).toHaveCount(0);
    await expect(page.locator('[data-room-morph-source]')).toHaveCount(0);
    await expect(current).toHaveCount(1);
    await settledPosition();
  };
  const open = async id => { await source(id).click(); await settle(); await expect(current).toHaveAttribute('data-room-detail', id); };
  const close = async () => {
    await current.locator('[data-room-back]').click();
    await expect(stage).toHaveCount(0); await expect(page.locator('.room-transition-ghost')).toHaveCount(0);
    await expect(page.locator('[data-room-morph-source]')).toHaveCount(0);
  };
  const finishAnimations = () => panel.evaluate(el => {
    for (const node of el.shadowRoot.querySelectorAll('*')) for (const animation of node.getAnimations()) {
      try { animation.finish(); } catch { animation.cancel(); }
    }
  });
  const seek = async (time, direction) => panel.evaluate(async (el, { time, direction }) => {
    const root = el.shadowRoot;
    const animations = [...root.querySelectorAll('*')].flatMap(node => node.getAnimations());
    for (const animation of animations) { animation.pause(); animation.currentTime = time; }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const ghost = root.querySelector('.room-transition-ghost'), rect = ghost.getBoundingClientRect();
    const title = ghost.querySelector('.room-transition-title'), photo = ghost.querySelector('.room-transition-photo');
    const svg = ghost.querySelector('svg')?.getBoundingClientRect();
    const target = root.querySelector('.room-detail[data-current-room]')?.getBoundingClientRect();
    return { direction, time, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      radius: getComputedStyle(ghost).borderRadius, transform: getComputedStyle(ghost).transform,
      titleTransform: title ? getComputedStyle(title).transform : null,
      photoTransform: photo ? getComputedStyle(photo).transform : null,
      svgWidth: svg?.width, svgHeight: svg?.height,
      target: target ? { x: target.x, y: target.y, width: target.width, height: target.height } : null,
      animations: animations.length };
  }, { time, direction });
  const touch = async (type, x, y) => {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y }] });
    activeTouch = type !== 'touchEnd' && type !== 'touchCancel';
  };
  const swipe = async (dx, dy = 0, origin, cancel = false) => {
    const box = await current.boundingBox();
    const start = origin || { x: box.x + (dx < 0 ? box.width * .76 : box.width * .24), y: box.y + 85 };
    await touch('touchStart', start.x, start.y);
    for (let step = 1; step <= 8; step++) {
      await touch('touchMove', start.x + dx * step / 8, start.y + dy * step / 8);
      await page.waitForTimeout(18);
    }
    await touch(cancel ? 'touchCancel' : 'touchEnd');
    await settledPosition();
  };
  const dot = async id => { await page.locator(`[data-room-page="${id}"]`).click(); await expect(current).toHaveAttribute('data-room-detail', id); await settledPosition(); };
  const quiet = async () => { await page.waitForTimeout(120); assert.equal(serviceEvents.length, 0, 'Room navigation must not call device services'); };

  await check('The card expands and returns at exact WAAPI geometry without stretching its title or icons', async () => {
    await source(first).scrollIntoViewIfNeeded();
    const origin = await card(first).boundingBox();
    const homeScroll = await page.evaluate(() => scrollY);
    await freeze(true); await source(first).click();
    await expect(page.locator('.room-transition-ghost')).toHaveCount(1);
    for (const time of [0, 240, 480]) {
      const sample = await seek(time, 'open'); report.geometry.push(sample);
      assert.ok(sample.animations > 0); assert.equal(sample.transform, 'none');
      if (sample.titleTransform) assert.equal(sample.titleTransform, 'none');
      if (sample.svgWidth) near(sample.svgWidth, sample.svgHeight, 'SVG aspect ratio remains square', .2);
      if (time === 0) for (const key of ['x', 'y', 'width', 'height']) near(sample[key], origin[key], `Opening starts at source ${key}`);
      if (time === 240) {
        assert.ok(sample.width > origin.width && sample.width < sample.target.width);
        assert.ok(sample.height > origin.height && sample.height < sample.target.height);
        await page.screenshot({ path: 'test-results/room-morph-240ms.png' });
      }
      if (time === 480) for (const key of ['x', 'y', 'width', 'height']) near(sample[key], sample.target[key], `Opening ends at detail ${key}`);
    }
    await finishAnimations(); await settle();
    await expect(current.locator('h1')).toBeFocused();
    assert.equal(await panel.locator('#app-content').evaluate(el => el.inert), true);
    const expanded = await current.boundingBox();
    assert.ok(expanded.width >= 350 && expanded.height >= 780, 'Room card occupies almost the entire 390×852 viewport');
    await page.screenshot({ path: 'test-results/room-morph-open.png' });
    await current.locator('[data-room-back]').click();
    await expect(page.locator('.room-transition-ghost')).toHaveCount(1);
    for (const time of [0, 180, 360]) {
      const sample = await seek(time, 'close'); report.geometry.push(sample);
      const destination = await card(first).boundingBox();
      if (time === 0) for (const key of ['x', 'y', 'width', 'height']) near(sample[key], expanded[key], `Closing starts at detail ${key}`);
      if (time === 360) for (const key of ['x', 'y', 'width', 'height']) near(sample[key], destination[key], `Closing ends at card ${key}`);
    }
    await finishAnimations(); await expect(stage).toHaveCount(0); await freeze(false);
    await expect(source(first)).toBeFocused();
    assert.equal(await panel.locator('#app-content').evaluate(el => el.inert), false);
    near(await page.evaluate(() => scrollY), homeScroll, 'Closing restores home scroll');
  });

  await check('Closing an unfinished entrance and opening another hash route cannot leave a stale ghost', async () => {
    await freeze(true); await source(first).click();
    await expect(page.locator('.room-transition-ghost')).toHaveCount(1);
    const midway = await seek(180, 'interrupted-open');
    await page.keyboard.press('Escape');
    await expect(page.locator('.room-transition-ghost')).toHaveCount(1);
    const closing = await seek(0, 'interrupted-close');
    for (const key of ['x', 'y', 'width', 'height']) near(closing[key], midway[key], `Interrupted reverse retains ${key}`, 2);
    await freeze(false);
    await page.evaluate(id => { location.hash = `room=${encodeURIComponent(id)}`; }, next);
    await settle(); await expect(current).toHaveAttribute('data-room-detail', next);
    await page.waitForTimeout(400);
    await expect(stage).toHaveCount(1); await expect(current).toHaveAttribute('data-room-detail', next);
    await close();
  });

  await check('Native horizontal swipes change adjacent rooms, clamp at the ends and preserve one history entry', async () => {
    await open(first); const opened = await page.evaluate(() => history.length);
    serviceEvents.length = 0;
    await swipe(-190); await expect(current).toHaveAttribute('data-room-detail', next);
    assert.equal(new URL(page.url()).hash, `#room=${encodeURIComponent(next)}`);
    assert.equal(await page.evaluate(() => history.length), opened);
    await swipe(190); await expect(current).toHaveAttribute('data-room-detail', first);
    await swipe(150); await expect(current).toHaveAttribute('data-room-detail', first);
    await dot(last); await swipe(-150); await expect(current).toHaveAttribute('data-room-detail', last);
    await dot(first); await swipe(-16); await expect(current).toHaveAttribute('data-room-detail', first);
    await swipe(-120, 0, undefined, true); await expect(current).toHaveAttribute('data-room-detail', first);
    await quiet();
  });

  await check('Vertical and vertically initiated diagonal touch gestures scroll instead of switching rooms', async () => {
    await panel.evaluate(el => {
      const style = document.createElement('style'); style.id = 'test-room-scroll';
      style.textContent = '.room-detail[data-current-room]::after { content:""; display:block; height:800px; }'; el.shadowRoot.append(style);
    });
    try {
      await current.evaluate(el => { el.scrollTop = 0; });
      const box = await current.boundingBox();
      const start = { x: box.x + box.width / 2, y: box.y + box.height - 140 };
      await swipe(0, -200, start);
      await expect.poll(() => current.evaluate(el => el.scrollTop)).toBeGreaterThan(30);
      await expect(current).toHaveAttribute('data-room-detail', first);
      await touch('touchStart', start.x, start.y);
      await touch('touchMove', start.x, start.y - 50); await page.waitForTimeout(40);
      await touch('touchMove', start.x - 120, start.y - 120); await touch('touchEnd');
      await expect(current).toHaveAttribute('data-room-detail', first);
      await quiet();
    } finally {
      await panel.evaluate(el => el.shadowRoot.querySelector('#test-room-scroll')?.remove());
      await current.evaluate(el => { el.scrollTop = 0; });
    }
  });

  await check('Swiping across a device-info row changes room without opening its native HA dialog', async () => {
    await dot(fixtures.light.room);
    await panel.evaluate(el => { window.__roomMoreInfo = []; el.addEventListener('hass-more-info', event => window.__roomMoreInfo.push(event.detail.entityId)); });
    const rowInfo = current.locator(`[data-more-info="${fixtures.light.entity_id}"]`);
    await rowInfo.scrollIntoViewIfNeeded();
    const rect = await rowInfo.boundingBox();
    const index = roomIds.indexOf(fixtures.light.room), direction = index < roomIds.length - 1 ? -1 : 1;
    const origin = { x: direction < 0 ? rect.x + rect.width - 10 : rect.x + 10, y: rect.y + rect.height / 2 };
    await swipe(direction * 165, 0, origin);
    await expect(current).toHaveAttribute('data-room-detail', roomIds[index - direction]);
    assert.deepEqual(await page.evaluate(() => window.__roomMoreInfo), []);
    await expect(page.locator('ha-more-info-dialog').getByRole('dialog')).not.toBeVisible();
  });

  await check('Closing a deeply scrolled room keeps the cropped hero inside the shrinking card', async () => {
    await dot(first);
    await panel.evaluate(el => {
      const style = document.createElement('style'); style.id = 'test-scrolled-close';
      style.textContent = '.room-detail[data-current-room]::after { content:""; display:block; height:600px; }'; el.shadowRoot.append(style);
    });
    try {
      await current.evaluate(el => { el.scrollTop = el.scrollHeight; });
      assert.ok(await current.evaluate(el => el.querySelector('h1').getBoundingClientRect().bottom < el.getBoundingClientRect().top));
      const closeButton = await current.locator('[data-room-back]').boundingBox();
      assert.ok(closeButton.y >= 12 && closeButton.y < 70, 'Close stays reachable while the room is scrolled');
      await freeze(true); await current.locator('[data-room-back]').click();
      await expect(page.locator('.room-transition-ghost')).toHaveCount(1);
      const sample = await seek(180, 'scrolled-close'); report.geometry.push(sample);
      assert.equal(await page.locator('.room-transition-ghost').evaluate(el => getComputedStyle(el).overflow), 'hidden');
      await page.screenshot({ path: 'test-results/room-morph-scrolled-close.png' });
      await finishAnimations(); await expect(stage).toHaveCount(0); await freeze(false);
      await expect(source(first)).toBeFocused();
    } finally {
      await panel.evaluate(el => el.shadowRoot.querySelector('#test-scrolled-close')?.remove());
    }
    await open(first);
  });

  await check('Touch light and cover hold-drag gestures stay in the room and commit only their own HA entity', async () => {
    await dot(fixtures.light.room); await current.evaluate(el => { el.scrollTop = 0; });
    fixturesChanged = true;
    for (const [kind, fixture] of [['light', fixtures.light], ['cover', fixtures.cover]]) {
      await service(kind, kind === 'light' ? 'turn_on' : 'set_cover_position', fixture.entity_id, kind === 'light' ? { brightness_pct: 70 } : { position: 70 });
      await expect.poll(() => panel.evaluate((el, [kind, id]) => kind === 'light'
        ? Math.round(el.hass.states[id].attributes.brightness / 255 * 100)
        : el.hass.states[id].attributes.current_position, [kind, fixture.entity_id])).toBe(70);
      await entityControl(fixture.entity_id).scrollIntoViewIfNeeded();
      const rect = await entityControl(fixture.entity_id).boundingBox(), point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      serviceEvents.length = 0;
      await touch('touchStart', point.x, point.y);
      await expect(page.locator('.adjust-bar')).toBeVisible({ timeout: 1500 });
      await touch('touchMove', point.x - 60, point.y);
      const expected = Number((await page.locator('#adjust-value').textContent()).replace(/\D/g, ''));
      assert.ok(expected > 0 && expected < 70);
      await touch('touchEnd'); await expect(page.locator('.adjust-bar')).toHaveCount(0);
      await expect(current).toHaveAttribute('data-room-detail', fixtures.light.room);
      await expect.poll(async () => kind === 'light' ? Math.round((await state(fixture.entity_id)).attributes.brightness / 255 * 100) : (await state(fixture.entity_id)).attributes.current_position).toBe(expected);
      await expect.poll(() => calls(fixture.entity_id).length).toBe(1);
      const ids = calls(fixture.entity_id)[0].service_data?.entity_id ?? calls(fixture.entity_id)[0].target?.entity_id;
      assert.deepEqual(Array.isArray(ids) ? ids : [ids], [fixture.entity_id]);
      assert.equal(await panel.locator('#app-content').evaluate(el => el.inert), true);
    }
    serviceEvents.length = 0;
    await entityControl(fixtures.light.entity_id).focus(); await page.keyboard.press('ArrowRight');
    await expect(page.locator('#adjust-range')).toBeFocused();
    assert.equal(await current.evaluate(el => !!el.closest('[inert]')), true, 'The room behind a keyboard adjustment stays inert');
    assert.equal(await panel.locator('#app-content').evaluate(el => el.inert), true);
    await page.keyboard.press('Escape'); await expect(page.locator('.adjust-bar')).toHaveCount(0);
    await expect(current).toHaveAttribute('data-room-detail', fixtures.light.room);
    await expect(entityControl(fixtures.light.entity_id)).toBeFocused();
    assert.equal(await current.evaluate(el => !!el.closest('[inert]')), false);
    assert.equal(await panel.locator('#app-content').evaluate(el => el.inert), true);
    await quiet();
    await close();
  });

  await check('Browser Back closes the room; Forward and direct reload restore the selected room without an entrance morph', async () => {
    await open(first); await dot(next);
    await page.goBack(); await expect(stage).toHaveCount(0); await expect(source(next)).toBeFocused();
    await page.goForward(); await settle(); await expect(current).toHaveAttribute('data-room-detail', next);
    await page.reload(); await page.locator('#ha-launch-screen').waitFor({ state: 'detached', timeout: 10000 });
    await settle(); await expect(current).toHaveAttribute('data-room-detail', next);
    assert.equal(await page.evaluate(() => window.__roomAnimationCalls.some(call => String(call.classes).includes('room-transition'))), false);
    await close();
  });

  await check('Reduced motion skips morphs and a live preference change finishes an in-progress entrance cleanly', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(first); await expect(page.locator('.room-transition-ghost')).toHaveCount(0);
    await expect(current.locator('h1')).toBeFocused(); await close();
    await page.emulateMedia({ reducedMotion: 'no-preference' }); await freeze(true); await source(first).click();
    await expect(page.locator('.room-transition-ghost')).toHaveCount(1);
    await page.emulateMedia({ reducedMotion: 'reduce' }); await settle();
    await freeze(false); await expect(current.locator('h1')).toBeFocused();
    await close(); await expect(source(first)).toBeFocused();
    assert.equal(await panel.locator('#app-content').evaluate(el => el.inert), false);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });

  await check('The enlarged card stays bounded on desktop and only the current room is accessible', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await panel.evaluate(el => { localStorage.setItem(el._themeKey(), 'dark'); el._applyTheme(); });
    await open(first);
    const rect = await current.boundingBox();
    const maxWidth = await page.locator('.room-viewport').evaluate(el => parseFloat(getComputedStyle(el).maxWidth));
    assert.ok(rect.width <= maxWidth + 1 && rect.width >= 700); assert.ok(rect.x >= 12 && rect.y >= 0);
    assert.ok(rect.x + rect.width <= 1280 && rect.y + rect.height <= 900);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const accessibility = await page.locator('.room-detail').evaluateAll(nodes => nodes.map(node => ({ current: node.hasAttribute('data-current-room'), inert: !!node.closest('[inert]'), hidden: !!node.closest('[aria-hidden="true"]') })));
    assert.equal(accessibility.filter(room => room.current).length, 1);
    assert.ok(accessibility.filter(room => !room.current).every(room => room.inert && room.hidden));
    await page.screenshot({ path: 'test-results/room-morph-desktop-dark.png' });
    await close();
  });
  assert.deepEqual(report.errors, []);
} catch (error) {
  failure = error;
  if (!report.results.some(result => !result.pass)) report.errors.push(error.stack || String(error));
  if (page) await page.screenshot({ path: 'test-results/room-morph-failure.png' }).catch(() => {});
} finally {
  const cleanup = async run => { try { await run(); } catch (error) { report.errors.push(`Cleanup: ${error.message}`); } };
  if (page) {
    if (activeTouch) await cleanup(() => cdp?.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }));
    await cleanup(() => page.mouse.up());
    if (appearance) await cleanup(() => page.locator('easy-hass-panel').evaluate((el, saved) => {
      if (saved.value === null) localStorage.removeItem(saved.key); else localStorage.setItem(saved.key, saved.value); el._applyTheme();
    }, appearance));
  }
  if (ha && initial && fixtures && fixturesChanged) {
    const saved = initial.get(fixtures.light.entity_id);
    if (saved.attributes.brightness != null) await cleanup(() => ha.call('call_service', { domain: 'light', service: 'turn_on', target: { entity_id: saved.entity_id }, service_data: { brightness: saved.attributes.brightness } }));
    await cleanup(() => ha.call('call_service', { domain: 'light', service: saved.state === 'on' ? 'turn_on' : 'turn_off', target: { entity_id: saved.entity_id }, service_data: {} }));
    await cleanup(() => ha.call('call_service', { domain: 'cover', service: 'set_cover_position', target: { entity_id: fixtures.cover.entity_id }, service_data: { position: initial.get(fixtures.cover.entity_id).attributes.current_position } }));
  }
  if (browser) await cleanup(() => browser.close()); ha?.close();
  await writeFile('test-results/browser-room-motion.json', `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.results.filter(result => result.pass).length, report: 'test-results/browser-room-motion.json' }));
if (failure) throw failure;
if (report.errors.length) throw new Error('Room motion checks reported browser or cleanup errors; see report');
