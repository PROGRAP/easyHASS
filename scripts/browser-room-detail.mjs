/** Room detail checks through the real local HA registries, services and native dialogs. */
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { localBrowser } from './browser-login.mjs';
import { LocalHA, baseUrl } from './ha-client.mjs';

const cardHitsOnly = process.argv.includes('--card-hits');
const reportPath = cardHitsOnly ? 'test-results/browser-room-card-hits.json' : 'test-results/browser-room-detail.json';
const report = { at: new Date().toISOString(), results: [], errors: [] };
await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
let ha, browser, page, initial, fixtures, appearance, groupEntry, groupFlow, groupEntity, tempArea, failure;
const groupName = `Easy-Hass Testgruppe ${Date.now()}`;
const serviceEvents = [];
const check = async (name, fn, cardHitCheck = false) => {
  if (cardHitsOnly && !cardHitCheck) return;
  try { await fn(); report.results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.results.push({ name, pass: false, error: error.stack || String(error) }); throw error; }
};

try {
  ha = await LocalHA.open();
  initial = new Map((await ha.call('get_states')).map(state => [state.entity_id, state]));
  const registry = await ha.call('config/entity_registry/list');
  const devices = await ha.call('config/device_registry/list');
  const areas = await ha.call('config/area_registry/list');
  const fixture = suffix => {
    const entity = registry.find(item => item.unique_id === `easy_hass_test_${suffix}`);
    assert.ok(entity, `Missing local fixture ${suffix}`);
    return { ...entity, room: entity.area_id || devices.find(device => device.id === entity.device_id)?.area_id };
  };
  fixtures = { light: fixture('living_light'), binary: fixture('living_onoff'), cover: fixture('living_cover'),
    temperature: fixture('living_temperature'), humidity: fixture('living_humidity'), kitchen: fixture('kitchen_light') };
  const room = areas.find(area => area.area_id === fixtures.light.room);
  assert.ok(room);
  await ha.call('subscribe_events', { event_type: 'call_service' }, event => serviceEvents.push(event.data));
  ({ browser, page } = await localBrowser({ hasTouch: true, reducedMotion: 'no-preference' }));
  page.on('pageerror', error => report.errors.push(error.message));
  const panel = page.locator('easy-hass-panel');
  const currentRoom = panel.locator('.room-detail[data-current-room]');
  const row = id => currentRoom.locator(`[data-entity-row="${id}"]`);
  const action = id => row(id).locator('[data-control]');
  const roomLink = id => page.locator(`.room-open[data-open-room="${id}"]`);
  const state = async id => (await ha.call('get_states')).find(item => item.entity_id === id);
  const service = (domain, name, ids, data = {}) => ha.call('call_service', { domain, service: name, target: { entity_id: ids }, service_data: data });
  const calls = id => serviceEvents.filter(event => {
    const ids = event.service_data?.entity_id ?? event.target?.entity_id ?? [];
    return (Array.isArray(ids) ? ids : [ids]).includes(id);
  });
  const assertOneTarget = async id => {
    await expect.poll(() => calls(id).length).toBe(1);
    await page.waitForTimeout(80);
    assert.equal(calls(id).length, 1);
    const ids = calls(id)[0].service_data?.entity_id ?? calls(id)[0].target?.entity_id;
    assert.deepEqual(Array.isArray(ids) ? ids : [ids], [id]);
  };
  const setLight = async (id, on, brightness) => {
    await service('light', on ? 'turn_on' : 'turn_off', id, on && brightness != null ? { brightness_pct: brightness } : {});
    await expect.poll(() => panel.evaluate((el, [id, on, brightness]) => {
      const current = el.hass.states[id];
      return current?.state === (on ? 'on' : 'off') && (!on || brightness == null || Math.round(current.attributes.brightness / 255 * 100) === brightness);
    }, [id, on, brightness])).toBe(true);
  };
  const hold = async id => {
    await action(id).scrollIntoViewIfNeeded();
    const rect = await action(id).boundingBox();
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await expect(page.locator('.adjust-bar')).toBeVisible({ timeout: 1500 });
    assert.equal(await panel.evaluate((el, id) => el._gesture?.room.id === `entity:${id}`
      && el._gesture.button.hasPointerCapture(el._gesture.pointerId), id), true);
    await expect(page.locator(`[data-morph-source][data-entity="${id}"]`)).toHaveCount(1);
    return point;
  };
  const waitRoomOpen = async (id, options = {}) => {
    await expect(currentRoom).toHaveAttribute('data-room-detail', id, options);
    await expect(currentRoom).toBeVisible(options);
    await expect(panel.locator('.room-transition-ghost')).toHaveCount(0);
  };
  const waitRoomClosed = async () => {
    await expect(panel.locator('.room-stage')).toHaveCount(0);
    await expect(panel.locator('.room-transition-ghost')).toHaveCount(0);
  };
  const openRoom = async id => {
    await waitRoomClosed();
    await roomLink(id).click();
    await waitRoomOpen(id);
  };
  const closeRoom = async () => {
    await currentRoom.locator('[data-room-back]').click();
    await waitRoomClosed();
  };
  const closeAdjust = async () => {
    await expect(page.locator('.adjust-bar')).toHaveCount(0);
    await expect(page.locator('[data-morph-source]')).toHaveCount(0);
  };
  const format = value => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(Number(value));
  appearance = await panel.evaluate(el => ({ key: el._themeKey(), value: localStorage.getItem(el._themeKey()) }));
  await panel.evaluate(el => { localStorage.setItem(el._themeKey(), 'light'); el._applyTheme(); });

  await check('Mouse and touch open rooms through the title, photo and free gap between control buttons', async () => {
    for (const mode of ['mouse', 'touch']) for (const spot of ['title', 'photo', 'control-gap']) {
      const card = page.locator(`[data-room-card="${room.area_id}"]`);
      await card.scrollIntoViewIfNeeded();
      const point = await card.evaluate((el, spot) => {
        let x, y;
        if (spot === 'control-gap') {
          const top = el.querySelector('[data-control="cover"]').getBoundingClientRect();
          const bottom = el.querySelector('[data-control="light"]').getBoundingClientRect();
          x = top.x + top.width / 2; y = (top.bottom + bottom.top) / 2;
        } else {
          const rect = el.querySelector(spot === 'title' ? 'h2' : '.room-picture').getBoundingClientRect();
          x = rect.x + rect.width / 2; y = rect.y + rect.height / 2;
        }
        return { x, y, hitRoom: el.getRootNode().elementFromPoint(x, y)?.closest('[data-open-room]')?.dataset.openRoom };
      }, spot);
      assert.equal(point.hitRoom, room.area_id, `${mode} ${spot} must reach the room link`);
      if (mode === 'mouse') await page.mouse.click(point.x, point.y); else await page.touchscreen.tap(point.x, point.y);
      await waitRoomOpen(room.area_id);
      assert.equal(new URL(page.url()).hash, `#room=${encodeURIComponent(room.area_id)}`);
      await closeRoom();
      await expect(roomLink(room.area_id)).toBeVisible();
    }
  }, true);

  await check('Both buttons retain their hit targets; coordinate mouse and touch light taps switch HA without navigating', async () => {
    const card = page.locator(`[data-room-card="${room.area_id}"]`);
    for (const mode of ['mouse', 'touch']) {
      await setLight(fixtures.light.entity_id, false); await setLight(fixtures.binary.entity_id, false);
      await card.scrollIntoViewIfNeeded();
      for (const kind of ['cover', 'light']) {
        const hit = await card.locator(`[data-control="${kind}"]`).evaluate(button => {
          const rect = button.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
          return { x, y, kind: button.getRootNode().elementFromPoint(x, y)?.closest('[data-control]')?.dataset.control };
        });
        assert.equal(hit.kind, kind, `${mode} ${kind} must reach its button`);
        if (kind !== 'light') continue;
        serviceEvents.length = 0;
        if (mode === 'mouse') await page.mouse.click(hit.x, hit.y); else await page.touchscreen.tap(hit.x, hit.y);
        for (const member of [fixtures.light, fixtures.binary]) {
          await expect.poll(async () => (await state(member.entity_id)).state).toBe('on');
          await expect.poll(() => calls(member.entity_id).length).toBe(1);
        }
        assert.equal(new URL(page.url()).hash, '');
        await expect(page.locator('.room-detail')).toHaveCount(0);
      }
    }
  }, true);

  await check('Direct title and photo clicks still open rooms when the overlay has no hit area', async () => {
    // A browser can serve an older stylesheet while replacing the panel module.
    await panel.evaluate(el => {
      const style = document.createElement('style');
      style.id = 'test-room-link-unavailable';
      style.textContent = '.room-open { display: none !important; }';
      el.shadowRoot.append(style);
    });
    try {
      for (const mode of ['mouse', 'touch']) for (const selector of ['h2', '.room-picture']) {
        const card = page.locator(`[data-room-card="${room.area_id}"]`);
        await card.scrollIntoViewIfNeeded();
        const point = await card.evaluate((el, selector) => {
          const rect = el.querySelector(selector).getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
          const hit = el.getRootNode().elementFromPoint(x, y), overlay = el.querySelector('.room-open').getBoundingClientRect();
          return { x, y, directCard: hit?.closest('[data-room-card]')?.dataset.roomCard,
            overlayHit: !!hit?.closest('[data-open-room]'), overlayWidth: overlay.width, overlayHeight: overlay.height };
        }, selector);
        assert.equal(point.directCard, room.area_id); assert.equal(point.overlayHit, false);
        assert.equal(point.overlayWidth, 0); assert.equal(point.overlayHeight, 0);
        if (mode === 'mouse') await page.mouse.click(point.x, point.y); else await page.touchscreen.tap(point.x, point.y);
        await waitRoomOpen(room.area_id);
        await closeRoom();
      }
    } finally {
      await panel.evaluate(el => el.shadowRoot.querySelector('#test-room-link-unavailable')?.remove());
    }
  }, true);

  await check('Room shortcut controls do not navigate; the card opens the actual HA room header and photo', async () => {
    await setLight(fixtures.light.entity_id, false); await setLight(fixtures.binary.entity_id, false);
    await page.locator(`[data-room-card="${room.area_id}"] [data-control="light"]`).click();
    await expect.poll(async () => (await state(fixtures.light.entity_id)).state).toBe('on');
    assert.equal(new URL(page.url()).hash, '');
    await expect(page.locator('.room-detail')).toHaveCount(0);
    await openRoom(room.area_id);
    assert.equal(new URL(page.url()).hash, `#room=${encodeURIComponent(room.area_id)}`);
    await expect(currentRoom.locator('.detail-header h1')).toHaveText(room.name);
    if (room.picture) {
      await expect(currentRoom.locator('.detail-photo img')).toHaveAttribute('src', new URL(room.picture, baseUrl).href);
      await expect.poll(() => currentRoom.locator('.detail-photo img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    }
    for (const sensor of [fixtures.temperature, fixtures.humidity]) {
      await expect(currentRoom.locator('.detail-climate')).toContainText(format(initial.get(sensor.entity_id).state));
    }
  });

  await check('Hash links survive reload, browser Back/Forward and the explicit room Back button', async () => {
    await page.reload();
    await waitRoomOpen(room.area_id, { timeout: 30000 });
    await closeRoom();
    await expect(roomLink(room.area_id)).toBeFocused();
    assert.equal(new URL(page.url()).hash, '');
    await openRoom(room.area_id);
    await page.goBack(); await waitRoomClosed(); await expect(roomLink(room.area_id)).toBeVisible();
    await page.goForward(); await waitRoomOpen(room.area_id);
  });

  await check('Only populated device sections appear, and names and sensor values come from HA', async () => {
    assert.deepEqual(await currentRoom.locator('.device-section h2').allTextContents(), ['Licht', 'Beschattung', 'Sensoren']);
    for (const fixture of [fixtures.light, fixtures.binary, fixtures.cover, fixtures.temperature, fixtures.humidity]) {
      await expect(row(fixture.entity_id)).toHaveCount(1);
      const expectedName = fixture.name || initial.get(fixture.entity_id).attributes.friendly_name || fixture.original_name || fixture.entity_id;
      await expect(row(fixture.entity_id).locator('.device-name')).toHaveAttribute('title', expectedName);
      const compactName = (await row(fixture.entity_id).locator('.device-name').textContent()).trim();
      assert.ok(compactName && expectedName.endsWith(compactName), 'Compact labels retain the actual HA name without its repeated room prefix');
    }
    for (const sensor of [fixtures.temperature, fixtures.humidity]) {
      await expect(row(sensor.entity_id).locator('.device-reading')).toHaveText(`${format(initial.get(sensor.entity_id).state)} ${initial.get(sensor.entity_id).attributes.unit_of_measurement}`);
      await expect(row(sensor.entity_id).locator('[data-control], [data-toggle-entity]')).toHaveCount(0);
    }
  });

  await check('An individual light tap and morph dim only that entity, not the other room light', async () => {
    await setLight(fixtures.light.entity_id, false); await setLight(fixtures.binary.entity_id, false); serviceEvents.length = 0;
    await action(fixtures.light.entity_id).click();
    await expect.poll(async () => (await state(fixtures.light.entity_id)).state).toBe('on');
    assert.equal((await state(fixtures.binary.entity_id)).state, 'off');
    await assertOneTarget(fixtures.light.entity_id);
    await setLight(fixtures.light.entity_id, true, 70); serviceEvents.length = 0;
    const point = await hold(fixtures.light.entity_id); await page.mouse.move(point.x - 65, point.y, { steps: 4 });
    const expected = Number((await page.locator('#adjust-value').textContent()).replace(/\D/g, ''));
    assert.ok(expected > 0 && expected < 70);
    await page.mouse.up(); await closeAdjust();
    await expect.poll(async () => Math.round((await state(fixtures.light.entity_id)).attributes.brightness / 255 * 100)).toBe(expected);
    await assertOneTarget(fixtures.light.entity_id);
    assert.equal((await state(fixtures.binary.entity_id)).state, 'off');
    assert.equal(new URL(page.url()).hash, `#room=${encodeURIComponent(room.area_id)}`);
  });

  await check('The individual cover retains its lilac morph and writes only its actual HA position', async () => {
    await service('cover', 'set_cover_position', fixtures.cover.entity_id, { position: 70 });
    await expect(action(fixtures.cover.entity_id)).toHaveAttribute('aria-label', /, 70 Prozent/); serviceEvents.length = 0;
    const point = await hold(fixtures.cover.entity_id); await page.mouse.move(point.x - 60, point.y, { steps: 4 });
    const expected = Number((await page.locator('#adjust-value').textContent()).replace(/\D/g, ''));
    assert.ok(expected > 0 && expected < 70);
    assert.equal(await page.locator('.adjust-fill').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(216, 199, 235)');
    await page.mouse.up(); await closeAdjust();
    await expect.poll(async () => (await state(fixtures.cover.entity_id)).attributes.current_position).toBe(expected);
    await assertOneTarget(fixtures.cover.entity_id);
  });

  await check('A sensor row opens Home Assistant’s native more-info dialog for that entity', async () => {
    await panel.evaluate(el => { window.__roomInfoEvents = []; el.addEventListener('hass-more-info', event => window.__roomInfoEvents.push(event.detail.entityId)); });
    await row(fixtures.temperature.entity_id).locator('.device-info').click();
    const dialog = page.locator('ha-more-info-dialog').getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    assert.deepEqual(await page.evaluate(() => window.__roomInfoEvents), [fixtures.temperature.entity_id]);
    await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
    await waitRoomOpen(room.area_id);
  });

  await check('A real HA light group replaces its two members and controls exactly the group entity', async () => {
    const start = await ha.api('/api/config/config_entries/flow', { handler: 'group' });
    groupFlow = start.flow_id;
    assert.equal(start.type, 'menu');
    const form = await ha.api(`/api/config/config_entries/flow/${start.flow_id}`, { next_step_id: 'light' });
    assert.equal(form.type, 'form'); assert.equal(form.step_id, 'light');
    const created = await ha.api(`/api/config/config_entries/flow/${start.flow_id}`, {
      name: groupName, entities: [fixtures.light.entity_id, fixtures.binary.entity_id], hide_members: false, all: false,
    });
    assert.equal(created.type, 'create_entry'); groupEntry = created.result.entry_id; groupFlow = null;
    await expect.poll(async () => {
      groupEntity = (await ha.call('config/entity_registry/list')).find(entity => entity.platform === 'group' && entity.config_entry_id === groupEntry);
      return Boolean(groupEntity);
    }).toBe(true);
    await ha.call('config/entity_registry/update', { entity_id: groupEntity.entity_id, area_id: room.area_id });
    await expect(row(groupEntity.entity_id)).toBeVisible();
    await expect(row(groupEntity.entity_id).locator('.device-state')).toContainText('Gruppe · 2 Geräte');
    await expect(row(fixtures.light.entity_id)).toHaveCount(0); await expect(row(fixtures.binary.entity_id)).toHaveCount(0);
    const memberRegistry = await ha.call('config/entity_registry/list');
    assert.equal(memberRegistry.find(entity => entity.entity_id === fixtures.light.entity_id).hidden_by, null, 'Our UI deduplicates visible members, rather than HA hiding them');
    await setLight(fixtures.light.entity_id, false); await setLight(fixtures.binary.entity_id, false);
    await expect(action(groupEntity.entity_id)).toHaveAttribute('aria-pressed', 'false');
    const kitchenBefore = await state(fixtures.kitchen.entity_id); serviceEvents.length = 0;
    await action(groupEntity.entity_id).click();
    for (const member of [fixtures.light, fixtures.binary]) await expect.poll(async () => (await state(member.entity_id)).state).toBe('on');
    await assertOneTarget(groupEntity.entity_id);
    assert.equal((await state(fixtures.kitchen.entity_id)).last_updated, kitchenBefore.last_updated);
  });

  await check('Group registry renames and unavailable states update live without duplicating members', async () => {
    await ha.call('config/entity_registry/update', { entity_id: groupEntity.entity_id, name: 'Abendlicht & Lesen' });
    await expect(row(groupEntity.entity_id).locator('.device-name')).toHaveText('Abendlicht & Lesen');
    const saved = await state(groupEntity.entity_id);
    await ha.api(`/api/states/${groupEntity.entity_id}`, { state: 'unavailable', attributes: saved.attributes });
    await expect(action(groupEntity.entity_id)).toBeDisabled();
    await expect(row(groupEntity.entity_id).locator('.device-state')).toContainText('Nicht verfügbar');
    await expect(row(fixtures.light.entity_id)).toHaveCount(0); await expect(row(fixtures.binary.entity_id)).toHaveCount(0);
    await service('light', 'turn_off', groupEntity.entity_id);
    await expect(action(groupEntity.entity_id)).toBeEnabled();
    await expect(row(groupEntity.entity_id).locator('.device-state')).toContainText('Gruppe · 2 Geräte');
  });

  await check('Room detail keeps the minimal light/dark design and fits mobile and desktop widths', async () => {
    for (const theme of ['light', 'dark']) {
      await panel.evaluate((el, theme) => { localStorage.setItem(el._themeKey(), theme); el._applyTheme(); }, theme);
      await expect(panel).toHaveAttribute('data-theme', theme);
      await currentRoom.evaluate(el => { el.scrollTop = 0; });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await row(groupEntity.entity_id).evaluate(el => getComputedStyle(el).borderRadius), '20px');
      assert.equal((await action(groupEntity.entity_id).boundingBox()).width, 44);
      await page.screenshot({ path: `test-results/room-detail-${theme}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await expect(row(groupEntity.entity_id)).toBeVisible();
    await page.screenshot({ path: 'test-results/room-detail-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 852 });
  });

  await check('A newly added HA room opens empty, updates its name and safely handles live deletion', async () => {
    await closeRoom();
    tempArea = await ha.call('config/area_registry/create', { name: `Gastzimmer & Büro ${Date.now()}` });
    await expect(roomLink(tempArea.area_id)).toBeVisible(); await openRoom(tempArea.area_id);
    await expect(currentRoom.locator('.empty-state')).toContainText('noch keine Geräte');
    await ha.call('config/area_registry/update', { area_id: tempArea.area_id, name: 'Büro <oben> & Gäste' });
    await expect(currentRoom.locator('h1')).toHaveText('Büro <oben> & Gäste');
    await ha.call('config/area_registry/delete', { area_id: tempArea.area_id }); tempArea = null;
    await expect(currentRoom.locator('h1')).toHaveText('Raum nicht mehr vorhanden');
    await closeRoom();
    await expect(roomLink(room.area_id)).toBeVisible();
    assert.equal(new URL(page.url()).hash, '');
  });
  assert.deepEqual(report.errors, [], 'No uncaught browser errors in room detail');
} catch (error) {
  failure = error;
  if (!report.results.some(result => !result.pass)) report.errors.push(error.stack || String(error));
  if (page) await page.screenshot({ path: 'test-results/room-detail-failure.png' }).catch(() => {});
} finally {
  const cleanup = async fn => { try { await fn(); } catch (error) { report.errors.push(`Cleanup: ${error.message}`); } };
  if (page) {
    await cleanup(() => page.mouse.up()); await cleanup(() => page.keyboard.press('Escape'));
    if (appearance) await cleanup(() => page.locator('easy-hass-panel').evaluate((el, saved) => {
      if (saved.value === null) localStorage.removeItem(saved.key); else localStorage.setItem(saved.key, saved.value);
      el._applyTheme();
    }, appearance));
  }
  if (ha && groupEntry) await cleanup(async () => {
    const entries = await ha.call('config_entries/get');
    const own = entries.find(entry => entry.entry_id === groupEntry);
    assert.ok(own?.domain === 'group' && own.title === groupName, 'Only remove this test’s own temporary helper');
    await ha.api(`/api/config/config_entries/entry/${groupEntry}`, undefined, 'DELETE');
  });
  if (ha && groupFlow) await cleanup(() => ha.api(`/api/config/config_entries/flow/${groupFlow}`, undefined, 'DELETE'));
  if (ha && tempArea) await cleanup(() => ha.call('config/area_registry/delete', { area_id: tempArea.area_id }));
  if (ha && fixtures && initial) {
    for (const fixture of [fixtures.light, fixtures.binary, fixtures.kitchen]) {
      const saved = initial.get(fixture.entity_id);
      await cleanup(async () => {
        if (saved.attributes.brightness != null) await ha.call('call_service', { domain: 'light', service: 'turn_on', target: { entity_id: fixture.entity_id }, service_data: { brightness: saved.attributes.brightness } });
        await ha.call('call_service', { domain: 'light', service: saved.state === 'on' ? 'turn_on' : 'turn_off', target: { entity_id: fixture.entity_id }, service_data: {} });
      });
    }
    await cleanup(() => ha.call('call_service', { domain: 'cover', service: 'set_cover_position', target: { entity_id: fixtures.cover.entity_id }, service_data: { position: initial.get(fixtures.cover.entity_id).attributes.current_position } }));
  }
  if (browser) await cleanup(() => browser.close()); ha?.close();
  await writeFile(new URL(`../${reportPath}`, import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.results.filter(result => result.pass).length, report: reportPath }));
if (failure) throw failure;
if (report.errors.length) throw new Error('Room detail checks reported browser or cleanup errors; see report');
