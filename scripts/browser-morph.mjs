/** Light/cover morph regression through the real, isolated HA frontend and fixture services. */
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { localBrowser } from './browser-login.mjs';
import { LocalHA } from './ha-client.mjs';

const report = { at: new Date().toISOString(), results: [], errors: [], geometry: [], directDrags: [] };
await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
let ha, browser, context, page, initial, fixtures, appearance, failure, cdp, activeTouch = false;
const serviceEvents = [];
const check = async (name, fn) => {
  try { await fn(); report.results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.results.push({ name, pass: false, error: error.stack || String(error) }); throw error; }
};

try {
  ha = await LocalHA.open();
  initial = new Map((await ha.call('get_states')).map(state => [state.entity_id, state]));
  const registry = await ha.call('config/entity_registry/list');
  const devices = await ha.call('config/device_registry/list');
  const fixture = suffix => {
    const entity = registry.find(item => item.unique_id === `easy_hass_test_${suffix}`);
    assert.ok(entity, `Missing isolated fixture ${suffix}`);
    return { ...entity, room: entity.area_id || devices.find(device => device.id === entity.device_id)?.area_id };
  };
  fixtures = { living: fixture('living_light'), binary: fixture('living_onoff'), kitchen: fixture('kitchen_light'), cover: fixture('living_cover') };
  await ha.call('subscribe_events', { event_type: 'call_service' }, event => serviceEvents.push(event.data));
  ({ browser, context, page } = await localBrowser({ hasTouch: true, reducedMotion: 'no-preference' }));
  cdp = await context.newCDPSession(page);
  page.on('pageerror', error => report.errors.push(error.message));
  const panel = page.locator('easy-hass-panel');
  report.revision = await panel.evaluate(el => el.shadowRoot.querySelector('link[rel="stylesheet"]').href.match(/builds\/([^/]+)\//)?.[1]);
  const control = (kind = 'light', room = fixtures.living.room) => page.locator(`[data-room-card="${room}"] [data-control="${kind}"]`);
  const state = async id => (await ha.call('get_states')).find(item => item.entity_id === id);
  const service = (domain, name, ids, data = {}) => ha.call('call_service', { domain, service: name, target: { entity_id: ids }, service_data: data });
  const calls = (domain = 'light') => serviceEvents.filter(event => {
    const ids = event.service_data?.entity_id ?? event.target?.entity_id ?? [];
    const id = domain === 'cover' ? fixtures.cover.entity_id : fixtures.living.entity_id;
    return event.domain === domain && (Array.isArray(ids) ? ids : [ids]).includes(id);
  });
  const quietCalls = async (expected, domain = 'light') => {
    await expect.poll(() => calls(domain).length).toBe(expected);
    await page.waitForTimeout(80); // Also catch a duplicate synthetic click after pointerup.
    assert.equal(calls(domain).length, expected);
  };
  const cleaned = async () => {
    await expect(page.locator('.adjust-bar')).toHaveCount(0);
    await expect(page.locator('[data-morph-source]')).toHaveCount(0);
    assert.deepEqual(await panel.evaluate(el => ({ gesture: !!el._gesture, adjustment: !!el._adjustment,
      closing: !!el._closingAdjustment, room: el._presentedRoomId || null,
      appInert: el.shadowRoot.getElementById('app-content').inert,
      overlayInert: el.shadowRoot.getElementById('overlay-root').inert,
      overlayHidden: el.shadowRoot.getElementById('overlay-root').hasAttribute('aria-hidden') })),
    { gesture: false, adjustment: false, closing: false, room: null, appInert: false, overlayInert: false, overlayHidden: false });
  };
  const prepare = async (value = 70) => {
    await service('light', 'turn_off', fixtures.binary.entity_id);
    await service('light', 'turn_on', fixtures.living.entity_id, { brightness_pct: value });
    await expect.poll(() => panel.evaluate((el, id) => Math.round(el.hass.states[id].attributes.brightness / 255 * 100), fixtures.living.entity_id)).toBe(value);
    await expect(control()).toHaveAttribute('aria-pressed', 'true');
    serviceEvents.length = 0;
  };
  const prepareCover = async (value = 70) => {
    await service('cover', 'set_cover_position', fixtures.cover.entity_id, { position: value });
    await expect.poll(() => panel.evaluate((el, id) => el.hass.states[id].attributes.current_position, fixtures.cover.entity_id)).toBe(value);
    await expect(control('cover', fixtures.cover.room)).toHaveAttribute('aria-label', new RegExp(`, ${value} %`));
    serviceEvents.length = 0;
  };
  const point = async locator => {
    await locator.scrollIntoViewIfNeeded();
    const rect = await locator.boundingBox();
    assert.ok(rect);
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  };
  const freeze = async value => page.evaluate(value => { window.__morphFreeze = value; }, value);
  const seek = async time => panel.evaluate(async (el, time) => {
    const root = el.shadowRoot.getElementById('overlay-root');
    const animations = [...root.querySelectorAll('*')].flatMap(node => node.getAnimations());
    for (const animation of animations) { animation.pause(); animation.currentTime = time; }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = root.querySelector('.adjust-bar').getBoundingClientRect();
    const svg = root.querySelector('.adjust-icon svg').getBoundingClientRect();
    const gesture = el._gesture;
    const source = (gesture?.button || el._closingAdjustment?.button)?.getBoundingClientRect();
    return { kind: (el._adjustment || el._closingAdjustment)?.kind, time, width: rect.width, height: rect.height, x: rect.x, y: rect.y,
      glyphWidth: svg.width, glyphHeight: svg.height, animations: animations.length,
      sourceWidth: source?.width, sourceHeight: source?.height, sourceX: source?.x, sourceY: source?.y,
      pointerCaptured: !!gesture?.button.hasPointerCapture(gesture.pointerId) };
  }, time);
  const hold = async (room = fixtures.living.room, kind = 'light') => {
    const p = await point(control(kind, room));
    await page.mouse.move(p.x, p.y); await page.mouse.down();
    await expect(page.locator('.adjust-bar')).toBeVisible({ timeout: 1500 });
    return p;
  };
  const touch = async (type, p) => {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: ['touchEnd', 'touchCancel'].includes(type) ? [] : [p] });
    activeTouch = !['touchEnd', 'touchCancel'].includes(type);
  };
  const startDirect = async (mode, locator) => {
    const p = await point(locator);
    await page.evaluate(() => { window.__morphDirectProbe = {}; });
    if (mode === 'mouse') { await page.mouse.move(p.x, p.y); await page.mouse.down(); }
    else await touch('touchStart', p);
    return p;
  };
  const moveDirect = (mode, p) => mode === 'mouse' ? page.mouse.move(p.x, p.y) : touch('touchMove', p);
  const endDirect = async mode => {
    if (mode === 'mouse') await page.mouse.up(); else await touch('touchEnd');
    await page.evaluate(() => { window.__morphDirectProbe = null; });
  };
  const directValue = async (kind, mode, scope = 'home', direction = -1) => {
    await expect(page.locator('.adjust-bar')).toBeVisible();
    const evidence = await page.evaluate(() => window.__morphDirectProbe);
    assert.ok(evidence.timerSuppressed, 'The 400 ms hold timer is disabled for this check');
    assert.ok(evidence.elapsed >= 0 && evidence.elapsed < 400, 'Horizontal motion opens the overlay before the hold threshold');
    assert.equal(evidence.anchorX, evidence.downX, 'The first movement uses the original pointer-down position');
    assert.equal(evidence.dirty, true, 'The same movement already changes the displayed value');
    assert.equal(evidence.captured, true);
    const value = Number((await page.locator('#adjust-value').textContent()).replace(/\D/g, ''));
    assert.ok(direction < 0 ? value > 0 && value < 70 : value > 70 && value < 100);
    assert.equal(serviceEvents.length, 0, 'Dragging only previews until release');
    report.directDrags.push({ kind, mode, scope, direction: direction < 0 ? 'left' : 'right', elapsed: evidence.elapsed, value });
    return value;
  };
  const expectSingleAdjustment = async (kind, value) => {
    const fixture = kind === 'cover' ? fixtures.cover : fixtures.living;
    await expect.poll(async () => kind === 'cover' ? (await state(fixture.entity_id)).attributes.current_position
      : Math.round((await state(fixture.entity_id)).attributes.brightness / 255 * 100)).toBe(value);
    await quietCalls(1, kind); assert.equal(serviceEvents.length, 1);
    const call = calls(kind)[0], targets = call.service_data?.entity_id ?? call.target?.entity_id;
    assert.deepEqual(Array.isArray(targets) ? targets : [targets], [fixture.entity_id], 'Only the capable fixture is targeted');
    assert.equal(call.service, kind === 'cover' ? 'set_cover_position' : 'turn_on');
  };
  // Pause only this panel's real WAAPI effects at creation, without changing durations/keyframes.
  // This makes exact timeline screenshots deterministic even on a busy host.
  appearance = await panel.evaluate(el => ({ key: el._themeKey(), value: localStorage.getItem(el._themeKey()) }));
  await panel.evaluate(el => { localStorage.setItem(el._themeKey(), 'light'); el._applyTheme(); });
  await page.evaluate(() => {
    window.__morphNativeAnimate = Element.prototype.animate;
    window.__morphFreeze = false;
    Element.prototype.animate = function (...args) {
      const animation = window.__morphNativeAnimate.apply(this, args);
      if (window.__morphFreeze && this.getRootNode()?.host?.localName === 'easy-hass-panel') {
        animation.pause(); animation.currentTime = 0;
      }
      return animation;
    };
  });
  await panel.evaluate(el => {
    // Disable only the native hold timer for the focused direct-drag checks.
    // Real mouse/touch events must open and update the overlay themselves.
    el.shadowRoot.addEventListener('pointerdown', () => {
      const probe = window.__morphDirectProbe, gesture = el._gesture;
      if (!probe || !gesture) return;
      probe.started = performance.now(); probe.downX = gesture.x;
      probe.timerSuppressed = !!gesture.timer; clearTimeout(gesture.timer);
    });
    el.shadowRoot.addEventListener('pointermove', () => {
      const probe = window.__morphDirectProbe, adjustment = el._adjustment, gesture = el._gesture;
      if (!probe || probe.elapsed !== undefined || !adjustment || !gesture) return;
      Object.assign(probe, { elapsed: performance.now() - probe.started, anchorX: adjustment.anchorX,
        dirty: adjustment.dirty, captured: gesture.button.hasPointerCapture(gesture.pointerId) });
    });
  });

  await check('Short tap still sends one real HA toggle and never morphs', async () => {
    await service('light', 'turn_off', [fixtures.living.entity_id, fixtures.binary.entity_id]);
    await expect(control()).toHaveAttribute('aria-pressed', 'false');
    serviceEvents.length = 0;
    await control().click();
    await expect.poll(async () => (await state(fixtures.living.entity_id)).state).toBe('on');
    await quietCalls(1);
    await cleaned();
  });

  await check('Mouse and real touch directly adjust light and cover before 400 ms, then commit only the displayed value once', async () => {
    for (const kind of ['light', 'cover']) for (const mode of ['mouse', 'touch']) {
      if (kind === 'light') await prepare(); else await prepareCover();
      const p = await startDirect(mode, control(kind, kind === 'cover' ? fixtures.cover.room : fixtures.living.room));
      const direction = mode === 'touch' ? 1 : -1;
      await moveDirect(mode, { x: p.x + direction * 60, y: p.y });
      const value = await directValue(kind, mode, 'home', direction);
      await endDirect(mode); await expectSingleAdjustment(kind, value); await cleaned();
      if (kind === 'light') assert.equal((await state(fixtures.binary.entity_id)).state, 'off');
    }
  });

  await check('Vertical or diagonal movement cancels light and cover gestures even if horizontal movement follows', async () => {
    for (const kind of ['light', 'cover']) for (const mode of ['mouse', 'touch']) {
      if (kind === 'light') await prepare(); else await prepareCover();
      const fixture = kind === 'cover' ? fixtures.cover : fixtures.living, before = await state(fixture.entity_id);
      const p = await startDirect(mode, control(kind, fixture.room));
      await moveDirect(mode, { x: p.x + (mode === 'touch' ? 20 : 0), y: p.y + 28 });
      await moveDirect(mode, { x: p.x - 70, y: p.y + 28 });
      await expect(page.locator('.adjust-bar')).toHaveCount(0);
      await endDirect(mode); await cleaned(); await quietCalls(0, kind); assert.equal(serviceEvents.length, 0);
      assert.equal((await state(fixture.entity_id)).last_updated, before.last_updated);
    }
  });

  await check('Room-detail permanent ranges adjust only their entity while binary lights expose only a toggle', async () => {
    await prepare();
    await page.locator(`[data-open-room="${fixtures.living.room}"]`).click();
    const detail = panel.locator('.room-detail[data-current-room]');
    await expect(detail).toHaveAttribute('data-room-detail', fixtures.living.room);
    await expect(panel.locator('.room-transition-ghost')).toHaveCount(0);
    const binary = detail.locator(`[data-inline-control="${fixtures.binary.entity_id}"]`);
    await expect(binary).toBeVisible();
    await expect(binary.locator('[data-inline-toggle]')).toBeEnabled();
    await expect(binary.locator('[data-inline-range]')).toHaveCount(0);
    const before = await state(fixtures.binary.entity_id);
    const dimmer = detail.locator(`[data-inline-range="${fixtures.living.entity_id}"]`);
    await dimmer.scrollIntoViewIfNeeded();
    const box = await dimmer.boundingBox();
    const p = await startDirect('mouse', dimmer);
    await moveDirect('mouse', { x: box.x + box.width * .35, y: p.y });
    const value = Number(await dimmer.inputValue());
    assert.ok(Math.abs(value - 35) <= 1);
    await expect(detail.locator(`[data-inline-control="${fixtures.living.entity_id}"] .inline-value`)).toHaveText(`${value} %`);
    assert.equal(serviceEvents.length, 0);
    await expect(page.locator('.adjust-bar')).toHaveCount(0);
    await endDirect('mouse'); await expectSingleAdjustment('light', value);
    assert.equal((await state(fixtures.binary.entity_id)).last_updated, before.last_updated);
    await expect(page.locator('.adjust-bar')).toHaveCount(0); await expect(page.locator('[data-morph-source]')).toHaveCount(0);
    await detail.locator('[data-room-back]').click(); await expect(panel.locator('.room-stage')).toHaveCount(0);
    await expect(panel.locator('.room-transition-ghost')).toHaveCount(0); await cleaned();
  });

  await check('Exact 0/160/320ms geometry morphs circle to full bar without squashing SVG or losing capture', async () => {
    await prepare(); await freeze(true); await hold();
    for (const time of [0, 160, 320]) {
      const geometry = await seek(time); report.geometry.push(geometry);
      assert.ok(geometry.animations > 0, 'Lamp must have real WAAPI animations');
      assert.equal(geometry.pointerCaptured, true);
      assert.ok(Math.abs(geometry.glyphWidth - geometry.glyphHeight) < 0.2, 'Bulb must not be scaled nonuniformly');
      assert.ok(Math.abs(geometry.glyphWidth - 22) < 0.5, 'Bulb retains its native size');
      if (time === 0) {
        for (const [actual, source] of [[geometry.width, geometry.sourceWidth], [geometry.height, geometry.sourceHeight], [geometry.x, geometry.sourceX], [geometry.y, geometry.sourceY]]) {
          assert.ok(Math.abs(actual - source) < 0.2, 'Morph starts at the exact pressed button bounds');
        }
      }
      if (time === 160) {
        assert.ok(geometry.width > 44 && geometry.width < 358);
        assert.ok(geometry.height > 44 && geometry.height < 92);
        await page.screenshot({ path: 'test-results/light-morph-160ms.png' });
      }
      if (time === 320) { assert.ok(Math.abs(geometry.width - 358) < 0.2); assert.ok(Math.abs(geometry.height - 92) < 0.2); }
    }
    await freeze(false); await page.mouse.up(); await cleaned(); await quietCalls(0);
  });

  await check('Release during entrance reverses from its current shape and leaves HA unchanged', async () => {
    await prepare(); const before = await state(fixtures.living.entity_id);
    await freeze(true); await hold(); const entrance = await seek(80);
    await page.mouse.up(); // Closing also pauses at its exact initial frame.
    const closing = await seek(0);
    assert.ok(Math.abs(closing.width - entrance.width) < 0.5, 'Reverse must not jump to the fully open bar');
    assert.equal(await panel.evaluate(el => !!el._closingAdjustment && !el._adjustment), true);
    await freeze(false);
    await panel.evaluate(el => el.shadowRoot.getElementById('overlay-root').querySelectorAll('*').forEach(node => node.getAnimations().forEach(animation => animation.play())));
    await cleaned(); await quietCalls(0);
    assert.equal((await state(fixtures.living.entity_id)).last_updated, before.last_updated);
  });

  await check('Dragging during entrance commits one displayed brightness through the actual HA service', async () => {
    await prepare(); await freeze(true); const p = await hold(); await seek(100);
    await page.mouse.move(p.x - 60, p.y, { steps: 4 });
    const expected = Number((await page.locator('#adjust-value').textContent()).replace(/\D/g, ''));
    assert.ok(expected > 0 && expected < 70);
    await freeze(false); await page.mouse.up();
    await expect.poll(async () => Math.round((await state(fixtures.living.entity_id)).attributes.brightness / 255 * 100)).toBe(expected);
    await quietCalls(1); await cleaned();
    assert.equal((await state(fixtures.binary.entity_id)).state, 'off');
  });

  await check('A rapid second-room hold survives disposal of the first closing animation', async () => {
    await prepare(); await freeze(true); await hold(); await seek(160); await page.mouse.up();
    assert.equal(await panel.evaluate(el => !!el._closingAdjustment), true);
    const p = await point(control('light', fixtures.kitchen.room));
    await page.mouse.move(p.x, p.y); await page.mouse.down();
    assert.equal(await panel.evaluate(el => !el._closingAdjustment), true);
    await expect(page.locator('.adjust-bar')).toBeVisible({ timeout: 1500 });
    await expect(page.locator('.adjust-title')).toHaveText('Küche');
    await page.waitForTimeout(260);
    assert.equal(await panel.evaluate((el, room) => el._adjustment?.room.id === room && el._gesture?.button.hasPointerCapture(el._gesture.pointerId), fixtures.kitchen.room), true);
    await expect(page.locator('[data-morph-source]')).toHaveCount(1);
    await freeze(false); await page.keyboard.press('Escape'); await page.mouse.up();
    await cleaned(); await quietCalls(0);
  });

  await check('Tab and arrow keys during a held pointer cannot replace the morph or leak its source', async () => {
    await prepare(); await freeze(true); await hold(); await seek(160);
    await panel.evaluate(el => { window.__morphHeldAdjustment = el._adjustment; window.__morphHeldButton = el._gesture.button; });
    for (const key of ['Tab', 'ArrowRight', 'Enter', 'Space']) await page.keyboard.press(key);
    assert.equal(await panel.evaluate(el => el._adjustment === window.__morphHeldAdjustment
      && !el._adjustment.keyboard && el._gesture.button === window.__morphHeldButton
      && el._gesture.button.hasPointerCapture(el._gesture.pointerId)), true);
    await expect(page.locator('.adjust-bar')).toHaveCount(1);
    await expect(page.locator('[data-morph-source]')).toHaveCount(1);
    await expect(page.locator('#adjust-range')).toHaveCount(0);
    await freeze(false); await page.keyboard.press('Escape'); await page.mouse.up();
    await cleaned(); await quietCalls(0);
  });

  await check('Keyboard morph keeps range focus, cancels without a command and restores the source focus', async () => {
    await prepare(); const before = await state(fixtures.living.entity_id);
    await control().focus(); await page.keyboard.press('ArrowRight');
    await expect(page.locator('#adjust-range')).toBeFocused();
    await page.keyboard.press('End'); await page.keyboard.press('Tab');
    await expect(page.locator('.adjust-actions [data-dismiss]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(control()).toBeFocused(); await cleaned(); await quietCalls(0);
    assert.equal((await state(fixtures.living.entity_id)).last_updated, before.last_updated);
  });

  await check('Keyboard Apply retains source focus while the real service response remains pending', async () => {
    await prepare();
    await panel.evaluate(el => {
      const owner = el.hass, original = owner.callService;
      const delayed = function (...args) {
        // Execute the actual HA command unchanged, only delay completion of its promise.
        return Promise.resolve(original.apply(this, args)).then(async result => {
          await new Promise(resolve => setTimeout(resolve, 650)); return result;
        });
      };
      window.__morphServiceRestore = () => {
        if (owner.callService === delayed) owner.callService = original;
        if (el.hass.callService === delayed) el.hass.callService = original;
      };
      owner.callService = delayed;
    });
    try {
      await control().focus(); await page.keyboard.press('ArrowRight');
      await page.keyboard.press('End'); await page.keyboard.press('Enter');
      await expect(control()).toBeFocused();
      assert.equal(await panel.evaluate((el, room) => el._pending.has(`${room}:light`), fixtures.living.room), true);
      assert.equal(await control().evaluate(el => el.disabled), false, 'Busy source must remain focusable');
      await page.waitForTimeout(300);
      await expect(control()).toBeFocused();
      assert.equal(await panel.evaluate((el, room) => el._pending.has(`${room}:light`), fixtures.living.room), true);
      await expect.poll(() => panel.evaluate((el, room) => el._pending.has(`${room}:light`), fixtures.living.room)).toBe(false);
      await expect(control()).toBeFocused();
      await expect.poll(async () => Math.round((await state(fixtures.living.entity_id)).attributes.brightness / 255 * 100)).toBe(100);
      await cleaned(); await quietCalls(1);
    } finally {
      await page.evaluate(() => { window.__morphServiceRestore?.(); window.__morphServiceRestore = null; });
    }
  });

  await check('Cover circle morphs into the lilac bar and back without squashing its icon or sending a command', async () => {
    await prepareCover(); const before = await state(fixtures.cover.entity_id);
    await freeze(true); await hold(fixtures.cover.room, 'cover');
    for (const time of [0, 160, 320]) {
      const geometry = await seek(time); report.geometry.push(geometry);
      assert.ok(geometry.animations > 0, 'Cover must use the same WAAPI morph');
      assert.equal(geometry.pointerCaptured, true);
      assert.ok(Math.abs(geometry.glyphWidth - geometry.glyphHeight) < 0.2, 'Cover icon must not be squashed');
      assert.ok(Math.abs(geometry.glyphWidth - 22) < 0.5);
      if (time === 0) {
        for (const [actual, source] of [[geometry.width, geometry.sourceWidth], [geometry.height, geometry.sourceHeight], [geometry.x, geometry.sourceX], [geometry.y, geometry.sourceY]]) {
          assert.ok(Math.abs(actual - source) < 0.2, 'Cover starts at its pressed button bounds');
        }
      }
      if (time === 160) {
        assert.ok(geometry.width > 44 && geometry.width < 358);
        assert.ok(geometry.height > 44 && geometry.height < 92);
        assert.equal(await page.locator('.adjust-fill').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(216, 199, 235)');
        await page.screenshot({ path: 'test-results/cover-morph-160ms.png' });
      }
      if (time === 320) { assert.ok(Math.abs(geometry.width - 358) < 0.2); assert.ok(Math.abs(geometry.height - 92) < 0.2); }
    }
    await page.mouse.up();
    assert.equal(await panel.evaluate(el => !!el._closingAdjustment && !el._adjustment), true);
    const returned = await seek(220);
    assert.ok(Math.abs(returned.width - returned.sourceWidth) < 0.2);
    assert.ok(Math.abs(returned.height - returned.sourceHeight) < 0.2);
    await freeze(false);
    await panel.evaluate(el => el.shadowRoot.getElementById('overlay-root').querySelectorAll('*').forEach(node => node.getAnimations().forEach(animation => animation.play())));
    await cleaned(); await quietCalls(0, 'cover');
    assert.equal((await state(fixtures.cover.entity_id)).last_updated, before.last_updated);
  });

  await check('Dragging the cover during entrance commits its displayed position exactly once to HA', async () => {
    await prepareCover(); await freeze(true); const p = await hold(fixtures.cover.room, 'cover'); await seek(100);
    await page.mouse.move(p.x - 60, p.y, { steps: 4 });
    const expected = Number((await page.locator('#adjust-value').textContent()).replace(/\D/g, ''));
    assert.ok(expected > 0 && expected < 70);
    await freeze(false); await page.mouse.up();
    await expect.poll(async () => (await state(fixtures.cover.entity_id)).attributes.current_position).toBe(expected);
    await quietCalls(1, 'cover'); await cleaned();
    assert.equal(calls('cover')[0].service, 'set_cover_position');
  });

  await check('Early cover cancellation discards a dragged draft and leaves the actual position unchanged', async () => {
    await prepareCover(); const before = await state(fixtures.cover.entity_id);
    await freeze(true); const p = await hold(fixtures.cover.room, 'cover'); await seek(80);
    await page.mouse.move(p.x - 40, p.y, { steps: 2 });
    await expect(page.locator('#adjust-value')).not.toHaveText('70 %');
    await freeze(false); await page.keyboard.press('Escape'); await page.mouse.up();
    await cleaned(); await quietCalls(0, 'cover');
    assert.equal((await state(fixtures.cover.entity_id)).last_updated, before.last_updated);
    assert.equal((await state(fixtures.cover.entity_id)).attributes.current_position, 70);
  });

  await check('Reduced motion skips light and cover effects and cleans up a live preference change', async () => {
    await prepare(); await page.emulateMedia({ reducedMotion: 'reduce' });
    await hold();
    assert.equal(await panel.evaluate(el => [...el.shadowRoot.getElementById('overlay-root').querySelectorAll('*')].flatMap(node => node.getAnimations()).length), 0);
    await expect(page.locator('[data-morph-source]')).toHaveCount(0);
    await page.mouse.up(); await cleaned();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await freeze(true); await hold(); await seek(100); await page.mouse.up();
    await page.emulateMedia({ reducedMotion: 'reduce' }); await cleaned();
    await freeze(false);
    await hold(fixtures.cover.room, 'cover');
    assert.equal(await panel.evaluate(el => [...el.shadowRoot.getElementById('overlay-root').querySelectorAll('*')].flatMap(node => node.getAnimations()).length), 0);
    await expect(page.locator('[data-morph-source]')).toHaveCount(0);
    await page.mouse.up(); await cleaned(); await quietCalls(0); await quietCalls(0, 'cover');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });
  assert.deepEqual(report.errors, [], 'No uncaught browser errors during morph lifecycle');
} catch (error) {
  failure = error;
  if (!report.results.some(result => !result.pass)) report.errors.push(error.stack || String(error));
  if (page) await page.screenshot({ path: 'test-results/light-morph-failure.png' }).catch(() => {});
} finally {
  const cleanup = async fn => { try { await fn(); } catch (error) { report.errors.push(`Cleanup: ${error.message}`); } };
  if (page) {
    await cleanup(() => page.evaluate(() => window.__morphServiceRestore?.()));
    await cleanup(() => page.evaluate(() => { window.__morphFreeze = false; if (window.__morphNativeAnimate) Element.prototype.animate = window.__morphNativeAnimate; }));
    await cleanup(() => page.keyboard.press('Escape'));
    if (activeTouch) await cleanup(() => cdp?.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }));
    await cleanup(() => page.mouse.up());
    await cleanup(() => page.emulateMedia({ reducedMotion: 'no-preference' }));
    if (appearance) await cleanup(() => page.locator('easy-hass-panel').evaluate((el, saved) => {
      if (saved.value === null) localStorage.removeItem(saved.key); else localStorage.setItem(saved.key, saved.value);
      el._applyTheme();
    }, appearance));
  }
  if (ha && fixtures && initial) for (const fixture of [fixtures.living, fixtures.binary, fixtures.kitchen]) {
    const saved = initial.get(fixture.entity_id);
    if (!saved) continue;
    await cleanup(async () => {
      if (saved.attributes.brightness != null) await ha.call('call_service', { domain: 'light', service: 'turn_on', target: { entity_id: fixture.entity_id }, service_data: { brightness: saved.attributes.brightness } });
      await ha.call('call_service', { domain: 'light', service: saved.state === 'on' ? 'turn_on' : 'turn_off', target: { entity_id: fixture.entity_id }, service_data: {} });
    });
  }
  if (ha && fixtures && initial) {
    const saved = initial.get(fixtures.cover.entity_id);
    if (saved?.attributes.current_position != null) await cleanup(() => ha.call('call_service', {
      domain: 'cover', service: 'set_cover_position', target: { entity_id: fixtures.cover.entity_id },
      service_data: { position: saved.attributes.current_position },
    }));
  }
  if (browser) await cleanup(() => browser.close());
  ha?.close();
  await writeFile(new URL('../test-results/browser-morph.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.results.filter(result => result.pass).length, report: 'test-results/browser-morph.json' }));
if (failure) throw failure;
if (report.errors.length) throw new Error('Morph checks reported browser or cleanup errors; see browser-morph.json');
