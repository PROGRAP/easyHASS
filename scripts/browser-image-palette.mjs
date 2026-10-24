/** Real-browser photo/header checks; synthetic pictures exist only in this browser. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { localBrowser } from './browser-login.mjs';
import { LocalHA, baseUrl } from './ha-client.mjs';

const report = { at: new Date().toISOString(), results: [], errors: [], palettes: [], screenshots: [] };
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7).toLowerCase();
await mkdir('test-results', { recursive: true });
let ha, browser, context, page, appearance, failure, releaseSlow;
const serviceCalls = [];
const check = async (name, run) => {
  if (only && !name.toLowerCase().includes(only) && !name.includes('remain browser-local')) return;
  try { await run(); report.results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.results.push({ name, pass: false, error: error.stack || String(error) }); throw error; }
};
const fingerprint = states => createHash('sha256').update(JSON.stringify(states
  .map(({ entity_id, state, attributes }) => ({ entity_id, state, attributes }))
  .sort((a, b) => a.entity_id.localeCompare(b.entity_id)))).digest('hex');
const luminance = rgb => rgb.map(channel => channel / 255)
  .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
  .reduce((sum, channel, i) => sum + channel * [.2126, .7152, .0722][i], 0);
const contrastOnWhite = rgb => 1.05 / (luminance(rgb) + .05);
const beige = rgb => rgb.length === 3 && rgb[0] > rgb[1] && rgb[1] > rgb[2] && rgb[0] - rgb[2] >= 12;
const blue = rgb => rgb.length === 3 && rgb[2] - rgb[0] >= 25 && rgb[2] - rgb[1] >= 12;
const neutral = rgb => rgb.length === 3 && Math.max(...rgb) - Math.min(...rgb) <= 14;
const slug = value => value.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9]+/g, '-');

try {
  ha = await LocalHA.open();
  const registry = await ha.call('config/entity_registry/list'), originalAreas = await ha.call('config/area_registry/list');
  const fixtureIds = new Set(registry.filter(entity => entity.unique_id?.startsWith('easy_hass_test_')).map(entity => entity.entity_id));
  const before = fingerprint((await ha.call('get_states')).filter(state => fixtureIds.has(state.entity_id)));
  await ha.call('subscribe_events', { event_type: 'call_service' }, event => serviceCalls.push(`${event.data.domain}.${event.data.service}`));
  ({ browser, context, page } = await localBrowser({ reducedMotion: 'reduce', deviceScaleFactor: 1 }));
  page.on('pageerror', error => report.errors.push(error.message));
  const panel = page.locator('easy-hass-panel'), current = panel.locator('.room-detail[data-current-room]');
  const header = current.locator('.detail-header'), picture = current.locator('.detail-photo img');
  const rooms = await panel.evaluate(el => el._home.rooms.map(({ id, name }) => ({ id, name })));
  assert.equal(rooms.length, 5, 'The isolated fixture contains five real HA rooms');
  const living = rooms.find(room => room.name === 'Wohnzimmer'); assert.ok(living);
  appearance = await panel.evaluate(el => ({ key: el._themeKey(), value: localStorage.getItem(el._themeKey()) }));
  const setTheme = async theme => {
    await panel.evaluate((el, theme) => { localStorage.setItem(el._themeKey(), theme); el._applyTheme(); }, theme);
    await expect(panel).toHaveAttribute('data-theme', theme);
  };
  const close = async () => {
    if (await current.count()) await current.locator('[data-room-back]').click();
    await expect(panel.locator('.room-stage, .room-transition-ghost')).toHaveCount(0);
  };
  const open = async room => {
    await close(); await panel.locator(`[data-open-room="${room.id}"]`).click();
    await expect(current).toHaveAttribute('data-room-detail', room.id);
    await expect(panel.locator('.room-transition-ghost')).toHaveCount(0);
  };
  const palette = () => header.evaluate(el => {
    const cs = getComputedStyle(el), parse = value => value.match(/[\d.]+/g)?.map(Number) || [];
    return { base: parse(cs.getPropertyValue('--room-photo-base')), shade: parse(cs.getPropertyValue('--room-photo-shade')) };
  });
  const waitPalette = async (predicate, label, state = 'ready') => {
    try {
      await expect(header).toHaveAttribute('data-photo-palette', state, { timeout: 10000 });
      await expect.poll(async () => predicate((await palette()).base), { message: label, timeout: 10000 }).toBe(true);
    }
    catch (error) {
      report.palettes.push({ label: `${label} (failed)`, ...await palette(), photoBounds: await current.locator('.detail-photo').boundingBox(),
        lifecycle: await panel.evaluate(el => {
          const photo = el.shadowRoot.querySelector('.room-detail[data-current-room] .detail-photo'), controller = el._roomPhotos;
          const record = controller?.photos.get(photo);
          return { record, cache: record ? controller.cache.get(record.key) : null,
            source: photo?.querySelector('img')?.getAttribute('src'), clientWidth: photo?.clientWidth, clientHeight: photo?.clientHeight,
            naturalWidth: photo?.querySelector('img')?.naturalWidth, naturalHeight: photo?.querySelector('img')?.naturalHeight };
        }) });
      throw error;
    }
    const colors = await palette();
    assert.ok(contrastOnWhite(colors.base) >= 4.5 - .03, 'Photo base supports white text at 4.5:1');
    assert.ok(luminance(colors.shade) <= luminance(colors.base) + .002, 'Gradient shade is no lighter than the base');
    report.palettes.push({ label, ...colors }); return colors;
  };
  const imageLoaded = () => expect.poll(() => picture.evaluate(image => image.complete && image.naturalWidth > 0), { timeout: 10000 }).toBe(true);
  const replacePicture = async url => {
    // Replace only the isolated browser's copy. No registry update API is called.
    await panel.evaluate((el, { id, url }) => {
      el._registries = { ...el._registries, areas: el._registries.areas.map(area => area.area_id === id ? { ...area, picture: url } : area) };
      el._update();
    }, { id: living.id, url });
    await expect(picture).toHaveAttribute('src', new URL(url, baseUrl).href);
  };
  const makePng = async (width, height, background, patches = []) => {
    const dataUrl = await page.evaluate(({ width, height, background, patches }) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = background; ctx.fillRect(0, 0, width, height);
      for (const { color, x, y, width, height } of patches) { ctx.fillStyle = color; ctx.fillRect(x, y, width, height); }
      return canvas.toDataURL('image/png');
    }, { width, height, background, patches });
    return Buffer.from(dataUrl.split(',')[1], 'base64');
  };
  const beigePng = await makePng(1000, 600, '#e0d0b4', [{ color: '#329148', x: 460, y: 0, width: 80, height: 600 }]);
  const solidBeigePng = await makePng(1000, 600, '#e0d0b4');
  const bluePng = await makePng(1000, 600, '#4878c5', [{ color: '#e0d0b4', x: 0, y: 0, width: 80, height: 600 }]);
  const images = new Map([['beige.png', beigePng], ['beige-solid.png', solidBeigePng], ['blue.png', bluePng]]);
  let slowRequests = 0, slowCompleted = 0;
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  await context.route(`${baseUrl}/local/easy-hass-palette-test/**`, async route => {
    const file = new URL(route.request().url()).pathname.split('/').at(-1);
    if (file === 'missing.png') return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Synthetic missing image' });
    if (file === 'slow-blue.png') {
      slowRequests++; await slowGate;
      try { await route.fulfill({ status: 200, contentType: 'image/png', body: bluePng }); } catch { /* A correctly canceled stale request is allowed. */ }
      slowCompleted++; return;
    }
    assert.ok(images.has(file), `Unexpected synthetic picture ${file}`);
    return route.fulfill({ status: 200, contentType: 'image/png', body: images.get(file) });
  });
  // Playwright adds a permissive CORS header when none is provided. Explicitly
  // allow a different origin so Chromium genuinely rejects the anonymous probe.
  await context.route('http://palette-test.invalid/no-cors.png', route => route.fulfill({ status: 200, contentType: 'image/png',
    headers: { 'access-control-allow-origin': 'http://different-origin.invalid' }, body: bluePng }));
  const url = file => `/local/easy-hass-palette-test/${file}`;
  await setTheme('light'); await open(living);

  await check('All five real room headers place their title and climate inside the photo in both themes', async () => {
    for (const theme of ['light', 'dark']) {
      await setTheme(theme);
      for (const room of rooms) {
        await open(room); await imageLoaded();
        await waitPalette(rgb => rgb.length === 3, `${room.name} ${theme}`);
        const geometry = await header.evaluate(el => {
          const rectangle = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
          const h1 = el.querySelector('h1'), climate = el.querySelector('.detail-climate'), tint = el.querySelector('.detail-photo-tint');
          return { photo: rectangle(el.querySelector('.detail-photo')), title: rectangle(h1), climate: rectangle(climate),
            tint: tint && rectangle(tint), titleColor: getComputedStyle(h1).color, text: h1.textContent };
        });
        assert.equal(geometry.text, room.name); assert.ok(geometry.tint, 'Photo gradient is a real DOM layer');
        for (const [name, rect] of [['title', geometry.title], ['climate', geometry.climate]]) {
          assert.ok(rect.x >= geometry.photo.x - 1 && rect.right <= geometry.photo.right + 1, `${name} fits photo horizontally`);
          assert.ok(rect.y >= geometry.photo.y - 1 && rect.bottom <= geometry.photo.bottom + 1, `${name} lies inside photo vertically`);
        }
        assert.ok(geometry.tint.width >= geometry.photo.width - 1 && geometry.tint.bottom >= geometry.photo.bottom - 1, 'Tint covers the header text background');
        const screenshot = `test-results/photo-header-${slug(room.name)}-${theme}.png`;
        await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
      }
    }
    await setTheme('light'); await open(living);
  });

  await check('A small green accent contributes to the area average while the broad beige surface keeps it warm', async () => {
    await replacePicture(url('beige-solid.png')); await imageLoaded();
    const solid = await waitPalette(beige, 'Uniform beige reference');
    await replacePicture(url('beige.png')); await imageLoaded();
    const mixed = await waitPalette(beige, 'Beige/green area average');
    assert.ok(mixed.base[1] / mixed.base[0] > solid.base[1] / solid.base[0] + .008,
      'The small green region influences the mean instead of being discarded by a winning-color cluster');
  });

  await check('The same room refreshes to a genuinely blue palette when its picture source changes', async () => {
    await replacePicture(url('blue.png')); await imageLoaded();
    await waitPalette(blue, 'Predominantly blue area average');
    await replacePicture(url('beige.png')); await imageLoaded();
    await waitPalette(beige, 'Returning to beige source');
  });

  await check('Responsive object-fit cropping resamples the visible photo without a source change', async () => {
    const naturalWidth = 1600, naturalHeight = 500;
    const mobile = await current.locator('.detail-photo').boundingBox();
    await page.setViewportSize({ width: 1280, height: 900 });
    const desktop = await current.locator('.detail-photo').boundingBox();
    const cropWidth = box => Math.min(naturalWidth, box.width / box.height * naturalHeight);
    const mobileCrop = cropWidth(mobile), desktopCrop = cropWidth(desktop);
    assert.ok(desktopCrop > mobileCrop * 1.35, 'Responsive viewports expose materially different centered crops');
    const stripeWidth = (mobileCrop + desktopCrop) / 4;
    images.set('crop.png', await makePng(naturalWidth, naturalHeight, '#4878c5', [
      { color: '#e0d0b4', x: (naturalWidth - stripeWidth) / 2, y: 0, width: stripeWidth, height: naturalHeight },
    ]));
    await page.setViewportSize({ width: 390, height: 852 });
    await replacePicture(url('crop.png')); await imageLoaded();
    const mobilePalette = await waitPalette(rgb => rgb.length === 3, 'Mobile crop average');
    await page.setViewportSize({ width: 1280, height: 900 });
    const desktopPalette = await waitPalette(rgb => rgb.length === 3
      && rgb[2] / rgb[0] > mobilePalette.base[2] / mobilePalette.base[0] + .15, 'Desktop wider crop has proportionally more blue');
    assert.ok(desktopPalette.base.some((value, i) => Math.abs(value - mobilePalette.base[i]) >= 12), 'The changed visible area materially changes the average');
    await page.setViewportSize({ width: 390, height: 852 });
    const restored = await waitPalette(rgb => rgb.every((value, i) => value === mobilePalette.base[i]), 'Resized back to the identical mobile average');
    assert.deepEqual(restored, mobilePalette, 'The same source and visible crop restore the same palette');
  });

  await check('A late old image response cannot overwrite the newer room palette', async () => {
    await replacePicture(url('slow-blue.png'));
    await expect.poll(() => slowRequests).toBeGreaterThan(0);
    await replacePicture(url('beige.png')); await imageLoaded();
    const chosen = await waitPalette(beige, 'New beige image before old response');
    releaseSlow();
    await expect.poll(() => slowCompleted).toBeGreaterThan(0);
    await page.waitForTimeout(250);
    assert.deepEqual(await palette(), chosen, 'The delayed blue response leaves the newer palette intact');
    await expect(picture).toHaveAttribute('src', new URL(url('beige.png'), baseUrl).href);
  });

  await check('A failed picture gets a readable neutral fallback and a later valid picture recovers', async () => {
    await replacePicture(url('blue.png')); await imageLoaded(); await waitPalette(blue, 'Blue before load failure');
    await replacePicture(url('missing.png'));
    await expect.poll(() => picture.evaluate(image => image.complete && image.naturalWidth === 0)).toBe(true);
    await waitPalette(neutral, 'Neutral missing-image fallback', 'fallback');
    await expect(current.locator('h1')).toHaveText(living.name);
    await panel.evaluate(el => { el._lastRoomMarkup = null; el._update(); });
    await expect(picture).toBeHidden();
    await expect(current.locator('.detail-photo')).toHaveClass(/picture-failed/);
    await waitPalette(neutral, 'Failed-image fallback survives HA DOM reconciliation', 'fallback');
    await replacePicture(url('beige.png')); await imageLoaded();
    await waitPalette(beige, 'Recovered image after failure');
    await expect(picture).toBeVisible();
  });

  await check('Cross-origin pixels without CORS permission safely use the neutral fallback', async () => {
    await replacePicture('http://palette-test.invalid/no-cors.png');
    await imageLoaded();
    const tainted = await picture.evaluate(image => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, 1, 1);
      try { ctx.getImageData(0, 0, 1, 1); return false; } catch (error) { return error.name === 'SecurityError'; }
    });
    assert.equal(tainted, true, 'The browser really prohibits reading the cross-origin image pixels');
    await waitPalette(neutral, 'Neutral cross-origin fallback', 'fallback');
    await expect(current.locator('h1')).toHaveText(living.name);
    await replacePicture(url('beige.png')); await imageLoaded(); await waitPalette(beige, 'Recovered from cross-origin fallback');
  });

  await check('A three-line room name stays readable over a white photo with a gradient anchored to the copy', async () => {
    images.set('white.png', await makePng(1000, 600, '#ffffff'));
    await panel.evaluate((el, id) => {
      el._registries = { ...el._registries, areas: el._registries.areas.map(area => area.area_id === id
        ? { ...area, name: 'Wohnzimmer mit Leseecke und großem Panoramafenster' } : area) };
      el._update();
    }, living.id);
    await replacePicture(url('white.png')); await imageLoaded(); await waitPalette(neutral, 'White photo average');
    const geometry = await header.evaluate(el => {
      const photo = el.querySelector('.detail-photo').getBoundingClientRect(), title = el.querySelector('h1').getBoundingClientRect();
      const climate = el.querySelector('.detail-climate').getBoundingClientRect(), lineHeight = parseFloat(getComputedStyle(el.querySelector('h1')).lineHeight);
      const lines = Math.round(title.height / lineHeight);
      return { lines, photoBottom: photo.bottom, titleBottom: title.bottom, climateBottom: climate.bottom,
        copyHeight: parseFloat(getComputedStyle(el).getPropertyValue('--room-photo-copy-height')),
        points: [...Array.from({ length: lines }, (_, index) => ({ label: `title-line-${index + 1}`, x: photo.x + 12, y: title.y + (index + .55) * lineHeight, minimum: 3 })),
          { label: 'climate', x: photo.x + 12, y: climate.y + climate.height / 2, minimum: 4.5 }] };
    });
    assert.ok(geometry.lines >= 3, 'The synthetic name wraps to at least three lines');
    assert.ok(geometry.copyHeight >= geometry.lines * 38, 'Gradient copy extent grows with the wrapped name');
    assert.ok(geometry.titleBottom <= geometry.photoBottom && geometry.climateBottom <= geometry.photoBottom, 'All copy remains inside the photo');
    const screenshot = 'test-results/photo-header-long-name.png', png = await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
    const samples = await page.evaluate(async ({ dataUrl, points }) => {
      const image = new Image(); image.src = dataUrl; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return points.map(point => ({ ...point, rgb: [...ctx.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data].slice(0, 3) }));
    }, { dataUrl: `data:image/png;base64,${png.toString('base64')}`, points: geometry.points });
    report.whitePhotoContrast = samples.map(sample => ({ ...sample, contrast: contrastOnWhite(sample.rgb) }));
    for (const sample of report.whitePhotoContrast) assert.ok(sample.contrast >= sample.minimum - .05,
      `${sample.label}: white text contrast ${sample.contrast.toFixed(2)} meets ${sample.minimum}:1`);
  });

  await check('Photo changes remain browser-local and trigger no Home Assistant device services', async () => {
    await page.reload(); await panel.locator('.room-card').first().waitFor({ timeout: 30000 });
    await open(living); await page.setViewportSize({ width: 1280, height: 900 }); await imageLoaded();
    await waitPalette(rgb => rgb.length === 3, 'Real Wohnzimmer desktop after restoring HA photos');
    await expect.poll(() => panel.locator('.room-slide').evaluateAll(slides => slides.filter(slide => {
      const r = slide.getBoundingClientRect(); return r.right > 0 && r.left < innerWidth;
    }).every(slide => slide.querySelector('.detail-header')?.dataset.photoPalette === 'ready'))).toBe(true);
    report.desktopPalettes = await panel.locator('.room-slide').evaluateAll(slides => slides.filter(slide => {
      const r = slide.getBoundingClientRect(); return r.right > 0 && r.left < innerWidth;
    }).map(slide => {
      const header = slide.querySelector('.detail-header'), cs = getComputedStyle(header), r = slide.getBoundingClientRect();
      return { room: slide.dataset.roomSlide, current: !!slide.querySelector('[data-current-room]'),
        base: cs.getPropertyValue('--room-photo-base').trim(), shade: cs.getPropertyValue('--room-photo-shade').trim(),
        x: r.x, width: r.width, visibleWidth: Math.min(innerWidth, r.right) - Math.max(0, r.left) };
    }));
    const screenshot = 'test-results/photo-header-wohnzimmer-desktop.png';
    await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
    assert.deepEqual(await ha.call('config/area_registry/list'), originalAreas, 'No HA area or picture was changed');
    assert.equal(fingerprint((await ha.call('get_states')).filter(state => fixtureIds.has(state.entity_id))), before, 'Fixture states and attributes are unchanged');
    assert.deepEqual(serviceCalls, [], 'No HA services were called');
    assert.deepEqual(report.errors, [], 'No uncaught browser errors');
  });
} catch (error) {
  failure = error;
  if (!report.results.some(result => !result.pass)) report.errors.push(error.stack || String(error));
  if (page) await page.screenshot({ path: 'test-results/photo-header-failure.png' }).catch(() => {});
} finally {
  releaseSlow?.();
  if (page && appearance) await page.locator('easy-hass-panel').evaluate((el, saved) => {
    if (saved.value === null) localStorage.removeItem(saved.key); else localStorage.setItem(saved.key, saved.value);
    el._applyTheme();
  }, appearance).catch(() => {});
  if (browser) await browser.close(); ha?.close();
  report.haServiceCalls = serviceCalls.length;
  await writeFile('test-results/browser-image-palette.json', `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.results.filter(result => result.pass).length, haServiceCalls: serviceCalls.length, report: 'test-results/browser-image-palette.json' }));
if (failure) throw failure;
if (report.errors.length) throw new Error('Photo header checks reported browser errors');
