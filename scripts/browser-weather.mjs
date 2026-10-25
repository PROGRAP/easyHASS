/** Weather dialog and chip morph against real local HA data; no device writes. */
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { localBrowser } from './browser-login.mjs';
import { LocalHA } from './ha-client.mjs';

const snapshotOnly = process.argv.includes('--snapshot');
const report = { at: new Date().toISOString(), results: [], errors: [], geometry: [] };
await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
let ha, browser, context, page, appearance, failure;
const check = async (name, fn, runInSnapshot = false) => {
  if (snapshotOnly && !runInSnapshot) return;
  try { await fn(); report.results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.results.push({ name, pass: false, error: error.stack || String(error) }); throw error; }
};
const number = (value, digits = 1) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits }).format(Number(value));
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1, `${message}: ${actual} ≈ ${expected}`);

try {
  ha = await LocalHA.open();
  const states = await ha.call('get_states');
  const weather = states.find(state => state.entity_id.startsWith('weather.') && !['unknown', 'unavailable'].includes(state.state)
    && Number.isFinite(state.attributes.temperature));
  assert.ok(weather, 'The local HA needs one real, available weather entity');
  report.entity = weather.entity_id;
  const liveForecasts = {};
  for (const [forecastType, flag] of [['hourly', 2], ['daily', 1]]) {
    if (!(weather.attributes.supported_features & flag)) continue;
    let receive, timer;
    const event = new Promise((resolve, reject) => {
      receive = resolve;
      timer = setTimeout(() => reject(new Error(`No live ${forecastType} forecast received`)), 20000);
    });
    const subscription = ha.sequence + 1;
    await ha.call('weather/subscribe_forecast', { entity_id: weather.entity_id, forecast_type: forecastType }, receive);
    try { liveForecasts[forecastType] = (await event).forecast || []; }
    finally { clearTimeout(timer); await ha.call('unsubscribe_events', { subscription }); }
  }
  ({ browser, context, page } = await localBrowser({ hasTouch: true, reducedMotion: 'no-preference', timezoneId: 'Europe/Berlin' }));
  page.on('pageerror', error => report.errors.push(error.message));
  const panel = page.locator('easy-hass-panel');
  const chip = panel.locator('button[data-weather-open]');
  const root = panel.locator('#weather-root');
  const dialog = root.locator('.weather-dialog[role="dialog"]');
  const close = dialog.locator('[data-weather-close]');
  const ghost = root.locator('.weather-morph-surface');
  const header = dialog.locator('.weather-header');
  const scroll = dialog.locator('.weather-scroll');
  const hours = dialog.locator('.weather-hours');
  appearance = await panel.evaluate(el => ({ key: el._themeKey(), value: localStorage.getItem(el._themeKey()) }));
  report.revision = await panel.evaluate(el => el.shadowRoot.querySelector('link[rel=stylesheet]')?.href.match(/builds\/([^/]+)/)?.[1]);
  await panel.evaluate(el => { localStorage.setItem(el._themeKey(), 'light'); el._applyTheme(); });
  await expect(chip).toBeVisible();
  await page.evaluate(() => {
    window.__weatherNativeAnimate = Element.prototype.animate;
    window.__weatherFreeze = false;
    Element.prototype.animate = function (...args) {
      const animation = window.__weatherNativeAnimate.apply(this, args);
      if (window.__weatherFreeze && this.getRootNode()?.host?.localName === 'easy-hass-panel') {
        animation.pause(); animation.currentTime = 0;
      }
      return animation;
    };
  });
  const freeze = value => page.evaluate(value => { window.__weatherFreeze = value; }, value);
  const play = async () => {
    await freeze(false);
    await panel.evaluate(el => {
      for (const node of el.shadowRoot.querySelectorAll('#weather-root, #weather-root *')) {
        for (const animation of node.getAnimations()) animation.play();
      }
    });
  };
  const seek = time => panel.evaluate((el, time) => {
    const root = el.shadowRoot.getElementById('weather-root');
    const animations = [...root.querySelectorAll('*')].flatMap(node => node.getAnimations());
    const duration = Math.max(0, ...animations.map(animation => Number(animation.effect.getComputedTiming().endTime) || 0));
    for (const animation of animations) { animation.pause(); animation.currentTime = time === 'end' ? Math.max(0, Number(animation.effect.getComputedTiming().endTime) - .1) : time; }
    const rect = element => { const r = element?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; };
    return { time, duration, animations: animations.length, surface: rect(root.querySelector('.weather-morph-surface')),
      source: rect(el.shadowRoot.querySelector('button[data-weather-open]')), target: rect(root.querySelector('.weather-dialog')),
      transform: root.querySelector('.weather-morph-surface') ? getComputedStyle(root.querySelector('.weather-morph-surface')).transform : null };
  }, time);
  const cleaned = async (focus = true) => {
    await expect(dialog).toHaveCount(0);
    await expect(ghost).toHaveCount(0);
    await expect(panel.locator('[data-weather-morph-source]')).toHaveCount(0);
    assert.equal(await panel.evaluate(el => el.shadowRoot.getElementById('app-content').inert), false);
    if (focus) await expect(chip).toBeFocused();
  };
  const opened = async () => { await expect(dialog).toBeVisible(); await expect(ghost).toHaveCount(0); };
  const open = async () => { await chip.click(); await opened(); };

  await check('The real weather chip opens a modal with current HA temperature and live forecasts', async () => {
    await open();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    assert.equal(await panel.evaluate(el => el._weatherOpen?.entityId), weather.entity_id);
    const actual = await panel.evaluate((el, id) => el.hass.states[id], weather.entity_id);
    await expect(dialog.locator('.weather-current-temperature')).toContainText(number(actual.attributes.temperature));
    await expect.poll(() => hours.locator('.weather-hour').count(), { timeout: 20000 }).toBeGreaterThan(1);
    await expect(hours).not.toContainText('Uhr Uhr');
    await expect.poll(() => dialog.locator('.weather-day').count(), { timeout: 20000 }).toBeGreaterThan(1);
    report.forecasts = { hourly: await hours.locator('.weather-hour').count(), daily: await dialog.locator('.weather-day').count() };
    const received = await panel.evaluate(el => el._weatherForecasts);
    for (const type of ['hourly', 'daily']) {
      assert.equal(received[type].status, 'ready');
      assert.equal(received[type].forecast.length, liveForecasts[type].length, `The panel receives all live ${type} entries`);
      assert.equal(Date.parse(received[type].forecast[0].datetime), Date.parse(liveForecasts[type][0].datetime));
      assert.equal(received[type].forecast[0].temperature, liveForecasts[type][0].temperature);
    }
    for (const [field, key, digits] of [['humidity', 'humidity', 0], ['pressure', 'pressure', 0], ['uv_index', 'uv', 1], ['cloud_coverage', 'clouds', 0], ['wind_speed', 'wind', 0]]) {
      if (typeof actual.attributes[field] !== 'number') continue;
      const metric = dialog.locator(`[data-weather-metric="${key}"] .weather-metric-value`);
      await expect(metric).toHaveCount(1);
      await expect(metric).toContainText(number(actual.attributes[field], digits));
    }
    if (typeof actual.attributes.dew_point === 'number') await expect(dialog.locator('.weather-metric').filter({ hasText: 'Taupunkt' })).toContainText(number(actual.attributes.dew_point));
    if (actual.attributes.apparent_temperature == null) await expect(dialog).not.toContainText('Gefühlt');
    if (actual.attributes.visibility == null) await expect(dialog.locator('.weather-metric').filter({ hasText: 'Sichtweite' })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/weather-detail-light.png' });
    if (snapshotOnly) {
      await panel.evaluate(el => { localStorage.setItem(el._themeKey(), 'dark'); el._applyTheme(); });
      await page.screenshot({ path: 'test-results/weather-detail-dark.png' });
    }
  }, true);

  await check('Hours scroll horizontally, details vertically, and the close header stays visible', async () => {
    const before = await header.boundingBox();
    await hours.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    assert.ok(await hours.evaluate(el => el.scrollLeft > 0 && el.scrollWidth > el.clientWidth));
    await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
    assert.ok(await scroll.evaluate(el => el.scrollTop > 0 && el.scrollHeight > el.clientHeight));
    const after = await header.boundingBox();
    near(after.y, before.y, 'Weather header remains fixed');
    await expect(close).toBeVisible();
    assert.equal(await panel.evaluate(el => el.shadowRoot.getElementById('app-content').inert), true);
    const blur = await root.locator('.weather-backdrop').evaluate(el => getComputedStyle(el).backdropFilter);
    assert.match(blur, /blur\(/);
    report.backdrop = blur;
    await close.focus();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press(i < 4 ? 'Tab' : 'Shift+Tab');
      assert.equal(await panel.evaluate(el => !!el.shadowRoot.activeElement?.closest('.weather-dialog')), true, 'Focus stays inside weather card');
    }
    await close.click(); await cleaned();
    await open(); await page.keyboard.press('Escape'); await cleaned();
    await open();
    const outside = await root.locator('.weather-backdrop').boundingBox();
    await page.mouse.click(outside.x + 3, outside.y + 3); await cleaned();
  });

  await check('Opening morph grows from the exact chip bounds without stretching its surface', async () => {
    await freeze(true); await chip.click(); await expect(ghost).toHaveCount(1);
    const start = await seek(0); report.geometry.push({ direction: 'open', ...start });
    assert.ok(start.animations > 0);
    for (const field of ['x', 'y', 'width', 'height']) near(start.surface[field], start.source[field], `Opening ${field}`);
    const mid = await seek(start.duration / 3); report.geometry.push({ direction: 'open', ...mid });
    assert.ok(mid.surface.height > start.source.height && mid.surface.height < start.target.height);
    assert.equal(mid.transform, 'none', 'The surface changes geometry rather than distorting text via scale');
    const end = await seek('end'); report.geometry.push({ direction: 'open', ...end });
    for (const field of ['x', 'y', 'width', 'height']) near(end.surface[field], end.target[field], `Open endpoint ${field}`);
    await play(); await opened();
    await freeze(true); await close.click(); await expect(ghost).toHaveCount(1);
    const reverse = await seek('end'); report.geometry.push({ direction: 'close', ...reverse });
    for (const field of ['x', 'y', 'width', 'height']) near(reverse.surface[field], reverse.source[field], `Close endpoint ${field}`);
    await play(); await cleaned();
  });

  await check('Escape during opening reverses from the current shape and cleans up', async () => {
    await freeze(true); await chip.click(); await expect(ghost).toHaveCount(1);
    const opening = await seek(100);
    await page.keyboard.press('Escape');
    const closing = await seek(0);
    for (const field of ['x', 'y', 'width', 'height']) near(closing.surface[field], opening.surface[field], `Interrupted ${field}`);
    await play(); await cleaned();
  });

  await check('Light and dark layouts fit 320px, phone and desktop widths', async () => {
    for (const theme of ['light', 'dark']) for (const viewport of [{ width: 320, height: 700 }, { width: 390, height: 852 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      await panel.evaluate((el, theme) => { localStorage.setItem(el._themeKey(), theme); el._applyTheme(); }, theme);
      await open();
      const box = await dialog.boundingBox();
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1);
      assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'The card itself never overflows horizontally');
      if (viewport.width === 390 && theme === 'dark') await page.screenshot({ path: 'test-results/weather-detail-dark.png' });
      await close.click(); await cleaned();
    }
    await page.setViewportSize({ width: 390, height: 852 });
  });

  await check('Reduced motion opens and closes immediately with normal focus restoration', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await chip.click(); await expect(dialog).toBeVisible(); await expect(ghost).toHaveCount(0);
    await close.click(); await cleaned();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });

  // These provider edge cases modify only this browser's view of HA. They do not
  // update HA states, configuration, services, or the real weather integration.
  const fixtureMode = async mode => panel.evaluate((el, { mode, entityId, forecasts }) => {
    let probe = window.__weatherFixture;
    if (!probe) {
      const connection = el.hass.connection;
      probe = window.__weatherFixture = { connection, subscribe: connection.subscribeMessage,
        liveHass: el.hass, setter: Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'hass').set,
        ownDescriptor: Object.getOwnPropertyDescriptor(el, 'hass'), active: 0, started: 0, stopped: 0, delayed: [] };
      Object.defineProperty(el, 'hass', { configurable: true, get() { return this._hass; }, set(value) { probe.liveHass = value; } });
      connection.subscribeMessage = function (callback, message, ...args) {
        if (message.type !== 'weather/subscribe_forecast') return probe.subscribe.call(this, callback, message, ...args);
        probe.started++;
        if (probe.mode === 'error' && message.forecast_type === 'hourly') return Promise.reject(new Error('Isolated weather test failure'));
        probe.active++;
        const event = { type: message.forecast_type, forecast: probe.mode === 'empty' ? [] : forecasts[message.forecast_type] };
        if (probe.mode === 'delayed') probe.delayed.push(() => callback(event));
        else queueMicrotask(() => callback(event));
        let active = true;
        return Promise.resolve(() => { if (active) { active = false; probe.active--; probe.stopped++; } });
      };
    }
    probe.mode = mode;
    const state = probe.liveHass.states[entityId];
    const attributes = mode === 'unsupported' ? { temperature: 19.5, temperature_unit: '°C', supported_features: 0 }
      : { ...state.attributes, supported_features: 3 };
    probe.setter.call(el, { ...probe.liveHass, states: { ...probe.liveHass.states, [entityId]: { ...state, attributes } } });
  }, { mode, entityId: weather.entity_id, forecasts: liveForecasts });
  const restoreFixture = () => panel.evaluate(el => {
    const probe = window.__weatherFixture;
    if (!probe) return;
    probe.connection.subscribeMessage = probe.subscribe;
    if (probe.ownDescriptor) Object.defineProperty(el, 'hass', probe.ownDescriptor); else delete el.hass;
    probe.setter.call(el, probe.liveHass);
    delete window.__weatherFixture;
  });

  await check('Forecast errors stay local, unsupported or missing fields are not invented, and late callbacks stay closed', async () => {
    try {
      await fixtureMode('error'); await open();
      await expect.poll(() => panel.evaluate(el => el._weatherForecasts?.hourly.status)).toBe('error');
      await expect.poll(() => dialog.locator('.weather-day').count()).toBeGreaterThan(0);
      await expect(hours.locator('.weather-hour')).toHaveCount(0);
      await close.click(); await cleaned();
      assert.equal(await page.evaluate(() => window.__weatherFixture.active), 0);

      await fixtureMode('unsupported'); await open();
      await expect.poll(() => panel.evaluate(el => el._weatherForecasts?.hourly.status)).toBe('unsupported');
      await expect.poll(() => panel.evaluate(el => el._weatherForecasts?.daily.status)).toBe('unsupported');
      await expect(dialog.locator('.weather-hour, .weather-day, .weather-metric')).toHaveCount(0);
      await expect(dialog.locator('.weather-current-temperature')).toContainText('19,5');
      await expect(dialog).not.toContainText(/NaN|undefined|Gefühlt|Regenrisiko/);
      await close.click(); await cleaned();

      await fixtureMode('empty'); await open();
      await expect.poll(() => panel.evaluate(el => el._weatherForecasts?.hourly.status)).toBe('ready');
      await expect(dialog.locator('.weather-hour, .weather-day')).toHaveCount(0);
      await expect(dialog).not.toContainText(/NaN|undefined/);
      await close.click(); await cleaned();
      assert.equal(await page.evaluate(() => window.__weatherFixture.active), 0);

      await fixtureMode('delayed'); await open();
      await expect.poll(() => panel.evaluate(el => el._weatherForecasts?.hourly.status)).toBe('loading');
      await close.click(); await cleaned();
      await page.evaluate(() => { for (const callback of window.__weatherFixture.delayed) callback(); });
      await cleaned();
      assert.equal(await page.evaluate(() => window.__weatherFixture.active), 0);
    } finally { await restoreFixture(); }
  });

  await check('Disconnect during the opening animation releases subscriptions, focus locks and temporary geometry', async () => {
    await fixtureMode('ready');
    await freeze(true); await chip.click(); await expect(ghost).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => window.__weatherFixture.active)).toBe(2);
    const cleanup = await panel.evaluate(async el => {
      const probe = window.__weatherFixture;
      el.remove();
      // HA's unsubscribe functions are released in a microtask so a provider's
      // synchronous or asynchronous cleanup failure cannot escape disposal.
      await Promise.resolve();
      await Promise.resolve();
      const state = {
        active: probe.active,
        ghost: el.shadowRoot.querySelectorAll('.weather-morph-surface').length,
        source: el.shadowRoot.querySelectorAll('[data-weather-morph-source]').length,
        dialog: el.shadowRoot.querySelectorAll('.weather-dialog').length,
        inert: el.shadowRoot.getElementById('app-content').inert,
      };
      probe.connection.subscribeMessage = probe.subscribe;
      delete window.__weatherFixture;
      return state;
    });
    assert.deepEqual(cleanup, { active: 0, ghost: 0, source: 0, dialog: 0, inert: false });
  });

  assert.deepEqual(report.errors, []);
} catch (error) { failure = error; console.error(error.stack || error); }
finally {
  if (page && !page.isClosed()) {
    try {
      await page.evaluate(appearance => {
        window.__weatherFreeze = false;
        if (window.__weatherNativeAnimate) Element.prototype.animate = window.__weatherNativeAnimate;
        const probe = window.__weatherFixture;
        if (probe) probe.connection.subscribeMessage = probe.subscribe;
        if (appearance) appearance.value == null ? localStorage.removeItem(appearance.key) : localStorage.setItem(appearance.key, appearance.value);
      }, appearance);
    } catch {}
    if (failure) await page.screenshot({ path: 'test-results/weather-detail-failure.png' }).catch(() => {});
  }
  await browser?.close(); ha?.close();
  await writeFile(new URL(snapshotOnly ? '../test-results/browser-weather-snapshot.json' : '../test-results/browser-weather.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
}
if (failure) process.exitCode = 1;
