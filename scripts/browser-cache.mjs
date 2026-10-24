/** Exercise the real HA service worker and a warm cache, in a disposable browser. */
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { localBrowser } from './browser-login.mjs';

const legacyProof = process.argv.includes('--legacy-proof');
const reportPath = legacyProof ? 'test-results/browser-cache-legacy.json' : 'test-results/browser-cache.json';
const report = { at: new Date().toISOString(), results: [], errors: [] };
const { browser, page } = await localBrowser({ hasTouch: true });
const assets = [];
const workerAssets = [];
let failure;
page.on('pageerror', error => report.errors.push(error.message));
page.on('response', response => {
  if (new URL(response.url()).pathname.startsWith('/easy_hass_static/')) {
    assets.push(response.url());
    if (response.fromServiceWorker()) workerAssets.push(response.url());
  }
});
const check = async (name, run) => {
  try { await run(); report.results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.results.push({ name, pass: false, error: error.stack || String(error) }); throw error; }
};
const settle = async () => {
  await page.locator('.room-card').first().waitFor({ timeout: 30000 });
  await page.locator('#ha-launch-screen').waitFor({ state: 'detached', timeout: 10000 });
  await page.evaluate(() => document.fonts.ready);
};
try {
  const panel = page.locator('easy-hass-panel');
  await check('The actual Home Assistant service worker controls this isolated browser', async () => {
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/service_worker.js', { scope: '/' });
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error('HA worker installation timed out')), 30000)),
      ]);
    });
    await page.reload(); await settle();
    report.worker = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
    assert.equal(new URL(report.worker).pathname, '/service_worker.js');
  });

  if (legacyProof) {
    await check('The real HA warm cache reproduces dead room clicks with the old stylesheet', async () => {
      const cssUrl = await panel.locator('link[rel="stylesheet"]').getAttribute('href');
      assert.ok(!cssUrl.includes('/builds/'), 'This diagnostic must run before the versioned graph is deployed');
      report.seed = await page.evaluate(async cssUrl => {
        const url = new URL(cssUrl, location.href).href;
        const response = await fetch(url), css = await response.text();
        const old = css.replace(/\.room-open(?::focus-visible)?\s*\{[^}]*\}/g, '');
        if (old === css) throw new Error('No room-link CSS found to remove');
        const cache = await caches.open('file-cache');
        await cache.put(url, new Response(old, { headers: { 'Content-Type': 'text/css', 'X-Easy-Hass-Cache-Proof': 'legacy' } }));
        return { url, removedBytes: css.length - old.length };
      }, cssUrl);
      const cssResponse = page.waitForResponse(response => response.url() === report.seed.url);
      await page.reload(); await settle();
      const response = await cssResponse;
      report.legacyCacheResponse = { fromServiceWorker: response.fromServiceWorker(), marker: await response.headerValue('x-easy-hass-cache-proof') };
      assert.equal(report.legacyCacheResponse.fromServiceWorker, true);
      assert.equal(report.legacyCacheResponse.marker, 'legacy');
      const card = page.locator('.room-card').first();
      const point = await card.evaluate(el => {
        const r = el.querySelector('h2').getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
        const a = el.querySelector('.room-open').getBoundingClientRect();
        return { x, y, hit: el.getRootNode().elementFromPoint(x, y)?.tagName, width: a.width, height: a.height };
      });
      await page.mouse.click(point.x, point.y); await page.waitForTimeout(100);
      report.legacy = { ...point, hash: new URL(page.url()).hash, detail: await page.locator('.room-detail').count() };
      assert.equal(point.width, 0); assert.equal(point.height, 0);
      assert.equal(report.legacy.hash, ''); assert.equal(report.legacy.detail, 0);
    });
  } else {
    await check('A warm HA file-cache contains old fixed module and stylesheet URLs', async () => {
      report.legacyKeys = await page.evaluate(async () => {
        const cache = await caches.open('file-cache');
        const entries = [
          ['/easy_hass_static/easy-hass.js?v=0.2.0', 'window.__easyHassLegacyModuleUsed = true;', 'text/javascript'],
          ['/easy_hass_static/easy-hass.js', 'window.__easyHassLegacyModuleUsed = true;', 'text/javascript'],
          ['/easy_hass_static/panel.css', ':host { --easy-hass-legacy-cache: 1 !important; }', 'text/css'],
          ['/easy_hass_static/ha-model.js', 'window.__easyHassLegacyModuleUsed = true;', 'text/javascript'],
        ];
        for (const [url, body, type] of entries) await cache.put(url, new Response(body, { headers: { 'Content-Type': type } }));
        return (await cache.keys()).map(request => request.url).filter(url => entries.some(([path]) => new URL(path, location.href).href === url));
      });
      assert.equal(report.legacyKeys.length, 4);
    });
    assets.length = 0;
    workerAssets.length = 0;
    await page.reload(); await settle();
    await check('Reload uses one versioned graph for JS, CSS and fonts without legacy cached assets', async () => {
      await page.evaluate(() => document.fonts.ready);
      report.assets = [...new Set(assets)];
      report.serviceWorkerAssets = [...new Set(workerAssets)];
      assert.ok(report.serviceWorkerAssets.some(url => new URL(url).pathname.endsWith('/panel.css')), 'The actual HA worker serves the stylesheet after reload');
      assert.ok(report.serviceWorkerAssets.some(url => new URL(url).pathname.endsWith('/easy-hass.js')), 'The actual HA worker serves the main module after reload');
      const prefixes = report.assets.map(url => new URL(url).pathname.match(/^\/easy_hass_static\/builds\/([a-f0-9]{64})\//)?.[1]);
      assert.ok(prefixes.length >= 5, 'The real module graph must have been requested');
      assert.ok(prefixes.every(Boolean), `Unexpected unversioned asset: ${report.assets.find((_, i) => !prefixes[i])}`);
      assert.equal(new Set(prefixes).size, 1, 'Every dependency uses the same content revision');
      assert.ok(report.assets.some(url => new URL(url).pathname.endsWith('/panel.css')));
      assert.ok(report.assets.some(url => new URL(url).pathname.endsWith('/assets/fonts/InterVariable.woff2')));
      assert.equal(await page.evaluate(() => Boolean(window.__easyHassLegacyModuleUsed)), false);
      assert.notEqual(await panel.evaluate(el => getComputedStyle(el).getPropertyValue('--easy-hass-legacy-cache').trim()), '1');
    });
    await check('A room title opens its detail view after the service-worker-controlled warm reload', async () => {
      const card = page.locator('.room-card').first(), id = await card.getAttribute('data-room-card');
      await card.scrollIntoViewIfNeeded();
      report.roomHit = await card.evaluate(el => {
        const r = el.querySelector('h2').getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
        const hit = el.getRootNode().elementFromPoint(x, y);
        return { x, y, tag: hit?.tagName, room: hit?.closest('[data-room-card]')?.dataset.roomCard };
      });
      assert.equal(report.roomHit.room, id, 'The launch screen must no longer intercept the coordinate click');
      await page.mouse.click(report.roomHit.x, report.roomHit.y);
      await expect(page.locator(`[data-room-detail="${id}"]`)).toBeVisible();
      assert.equal(new URL(page.url()).hash, `#room=${encodeURIComponent(id)}`);
    });
  }
  assert.deepEqual(report.errors, []);
} catch (error) {
  failure = error;
  if (!report.results.some(result => !result.pass)) report.errors.push(error.stack || String(error));
} finally {
  await browser.close(); // All service worker registrations and cache seeds belong only to this context.
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.results.filter(result => result.pass).length, report: reportPath }));
if (failure) throw failure;
