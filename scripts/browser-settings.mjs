/** Settings UI against the isolated local HA; only this test's own area is written. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { localBrowser } from './browser-login.mjs';
import { LocalHA } from './ha-client.mjs';

const report = { at: new Date().toISOString(), results: [], errors: [], screenshots: [] };
await mkdir('test-results', { recursive: true });
const suffix = `${Date.now()}-${randomUUID().slice(0, 6)}`;
const createdName = `Easy-Hass Test ${suffix}`;
const renamedName = `Easy-Hass Test Büro ${suffix}`;
const photoName = `Easy-Hass Test Foto ${suffix}`;
const imageFilename = `Easy-Hass Test ${suffix}.png`;
const ownedNames = new Set([createdName, renamedName, photoName]);
const ownedImageNames = new Set([imageFilename]);
let ha, browser, page, appearance, initialAreas, initialDevices, initialEntities, initialImages, initialStates, fixtureIds, tempAreaId, uploadedPicture, createAttempted = false, failure;
const serviceCalls = [], areaCreateEvents = new Set(), imageUploadRequests = [], imageResponseTasks = [], ownedImageIds = new Set();
const isImageUpload = request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/image/upload';
const check = async (name, run) => {
  try { await run(); report.results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.results.push({ name, pass: false, error: error.stack || String(error) }); throw error; }
};
const sorted = (items, key) => [...items].sort((a, b) => a[key].localeCompare(b[key]));
const fingerprint = states => createHash('sha256').update(JSON.stringify(sorted(states
  .map(({ entity_id, state, attributes }) => ({ entity_id, state, attributes })), 'entity_id'))).digest('hex');

try {
  ha = await LocalHA.open();
  [initialAreas, initialDevices, initialEntities, initialImages] = await Promise.all([
    ha.call('config/area_registry/list'), ha.call('config/device_registry/list'), ha.call('config/entity_registry/list'), ha.call('image/list'),
  ]);
  assert.ok(initialAreas.length, 'The isolated local HA has actual areas');
  assert.ok(!initialAreas.some(area => ownedNames.has(area.name)), 'The test area names are unique');
  fixtureIds = new Set(initialEntities.filter(entity => entity.unique_id?.startsWith('easy_hass_test_')).map(entity => entity.entity_id));
  initialStates = fingerprint((await ha.call('get_states')).filter(state => fixtureIds.has(state.entity_id)));
  await ha.call('subscribe_events', { event_type: 'call_service' }, event => serviceCalls.push(`${event.data.domain}.${event.data.service}`));
  await ha.call('subscribe_events', { event_type: 'area_registry_updated' }, event => {
    if (event.data.action === 'create') areaCreateEvents.add(event.data.area_id);
  });
  ({ browser, page } = await localBrowser({ reducedMotion: 'reduce', hasTouch: true }));
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('request', request => { if (isImageUpload(request)) imageUploadRequests.push({ method: request.method(), path: new URL(request.url()).pathname }); });
  page.on('response', response => {
    if (!isImageUpload(response.request()) || !response.ok()) return;
    imageResponseTasks.push(response.json().then(image => {
      assert.ok(image.id && ownedImageNames.has(image.name) && !initialImages.some(original => original.id === image.id),
        'Only this run’s uniquely named images may be uploaded');
      ownedImageIds.add(image.id);
    }).catch(error => { report.errors.push(`Image upload audit: ${error.message}`); }));
  });
  const panel = page.locator('easy-hass-panel'), dialog = panel.getByRole('dialog');
  const more = panel.locator('[data-tab="more"]'), title = panel.locator('#settings-title');
  const back = panel.locator('[data-settings-back]'), create = panel.locator('[data-settings-new]');
  const form = panel.locator('.settings-form'), input = form.locator('#settings-room-name');
  const save = form.locator('[data-settings-save]'), alert = form.locator('[role="alert"]');
  const imageInput = form.locator('#settings-room-picture'), imageButton = form.locator('[data-settings-picture]');
  const imagePreview = form.locator('img.settings-picture-preview'), imageRemove = form.locator('[data-settings-picture-remove]');
  const imagePlaceholder = form.locator('.settings-picture-placeholder'), imageError = form.locator('#settings-picture-error');
  const areaRow = id => panel.locator(`[data-settings-area="${id}"]`);
  const ownArea = async () => (await ha.call('config/area_registry/list')).find(area => area.area_id === tempAreaId);
  const imageBuffer = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
    const context = canvas.getContext('2d');
    context.fillStyle = '#c5ac88'; context.fillRect(0, 0, 96, 64);
    context.fillStyle = '#466b61'; context.fillRect(64, 0, 32, 64);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  const chooseTestImage = async () => {
    await imageInput.setInputFiles({ name: imageFilename, mimeType: 'image/png', buffer: imageBuffer });
    await expect(imagePreview).toBeVisible(); await expect(imagePreview).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => imagePreview.evaluate(image => image.complete && image.naturalWidth === 96)).toBe(true);
  };
  appearance = await panel.evaluate(el => ({ key: el._themeKey(), value: localStorage.getItem(el._themeKey()) }));
  const theme = async value => {
    await panel.evaluate((el, value) => { localStorage.setItem(el._themeKey(), value); el._applyTheme(); }, value);
    await expect(panel).toHaveAttribute('data-theme', value);
  };
  const screenshot = async name => {
    const path = `test-results/settings-${name}.png`;
    await page.screenshot({ path }); report.screenshots.push(path);
  };
  const dismiss = async () => {
    // A nested sheet may handle Escape by stepping back or closing its stack.
    // In either case, repeated Escape must return to the launching menu button.
    for (let count = 0; count < 5 && await dialog.count(); count++) await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(more).toBeFocused();
  };
  const openSettings = async () => {
    if (await dialog.count()) await dismiss();
    await more.click();
    await expect(dialog.getByRole('heading', { name: 'Mehr', exact: true })).toBeVisible();
    await panel.locator('[data-settings-page="settings"]').click();
    await expect(title).toHaveText('Einstellungen');
  };
  const openRooms = async () => {
    await openSettings(); await panel.locator('[data-settings-page="rooms"]').click();
    await expect(title).toHaveText('Räume');
  };
  const expectRoomList = async () => {
    const areas = await ha.call('config/area_registry/list');
    await expect.poll(async () => (await panel.locator('[data-settings-area]').evaluateAll(rows => rows.map(row => row.dataset.settingsArea))).sort())
      .toEqual(areas.map(area => area.area_id).sort());
    await expect(panel.locator('[data-settings-area="__easy_hass_unassigned__"]')).toHaveCount(0);
    for (const area of areas) await expect(areaRow(area.area_id)).toContainText(area.name);
  };
  const assertFocusContained = () => expect.poll(() => panel.evaluate(el => {
    const active = el.shadowRoot.activeElement, sheet = el.shadowRoot.querySelector('[role="dialog"]');
    return !!active && !!sheet?.contains(active);
  })).toBe(true);

  await check('Mehr opens Einstellungen and Räume; back navigation and Escape return focus to the menu', async () => {
    await theme('light'); await openRooms(); await expectRoomList();
    await screenshot('rooms-light');
    await back.click(); await expect(title).toHaveText('Einstellungen');
    await back.click(); await expect(dialog.getByRole('heading', { name: 'Mehr', exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(more).toBeFocused();
    await openRooms(); await create.click();
    await expect(form).toBeVisible(); await expect(input).toBeFocused();
    await input.fill(`Easy-Hass Test Nicht speichern ${suffix}`);
    await dismiss();
    assert.deepEqual(sorted(await ha.call('config/area_registry/list'), 'area_id'), sorted(initialAreas, 'area_id'), 'Escape does not create an unsaved draft');
  });

  await check('The room list contains only actual HA areas and no synthetic unassigned room', async () => {
    await openRooms(); await expectRoomList();
    await expect(create).toBeVisible();
    await expect(panel.locator('.settings-form')).toHaveCount(0);
  });

  await check('A whitespace-only room name is rejected without changing HA or discarding the input', async () => {
    const before = sorted(await ha.call('config/area_registry/list'), 'area_id');
    await create.click(); await input.fill('   '); await input.press('Enter');
    await expect(alert).toBeVisible(); await expect(alert).toContainText(/name|namen/i);
    await expect(input).toHaveValue('   '); await expect(input).toBeFocused();
    assert.deepEqual(sorted(await ha.call('config/area_registry/list'), 'area_id'), before);
    await back.click(); await expect(title).toHaveText('Räume');
  });

  await check('Submitting from the name input keeps keyboard focus inside the sheet while saving', async () => {
    const before = sorted(await ha.call('config/area_registry/list'), 'area_id');
    const pendingName = `Easy-Hass Test Pending ${suffix}`;
    await create.click(); await input.fill(pendingName);
    // Hold and reject only this draft in the browser. The real HA create command
    // is never sent, so this focus check cannot leave an extra test area behind.
    await panel.evaluate((el, name) => {
      const hass = el.hass, original = hass.callWS;
      const test = window.__settingsPendingTest = { hass, original, calls: 0, reject: null };
      hass.callWS = function (message) {
        if (message.type === 'config/area_registry/create' && message.name === name) {
          test.calls++; return new Promise((resolve, reject) => { test.reject = reject; });
        }
        return original.call(this, message);
      };
    }, pendingName);
    try {
      await input.press('Enter');
      await expect.poll(() => page.evaluate(() => window.__settingsPendingTest.calls)).toBe(1);
      await expect(form).toHaveAttribute('aria-busy', 'true');
      await expect(input).toBeDisabled(); await expect(save).toBeDisabled();
      await assertFocusContained(); await expect(back).toBeFocused();
      for (const key of ['Tab', 'Shift+Tab']) { await page.keyboard.press(key); await assertFocusContained(); await expect(back).toBeFocused(); }
    } finally {
      await page.evaluate(() => {
        const test = window.__settingsPendingTest;
        if (test) { test.hass.callWS = test.original; test.reject?.(new Error('Test: Speichern vorübergehend nicht erreichbar.')); delete window.__settingsPendingTest; }
      });
    }
    await expect(input).toBeEnabled(); await expect(input).toHaveValue(pendingName); await expect(input).toBeFocused();
    await expect(alert).toContainText('Speichern vorübergehend nicht erreichbar');
    assert.deepEqual(sorted(await ha.call('config/area_registry/list'), 'area_id'), before);
    await back.click(); await expect(title).toHaveText('Räume');
  });

  await check('A pending save from a detached panel cannot change the reattached panel', async () => {
    const before = sorted(await ha.call('config/area_registry/list'), 'area_id');
    const pendingName = `Easy-Hass Test Detached ${suffix}`;
    const fakeArea = { area_id: `easy_hass_test_detached_${suffix.replaceAll('-', '_')}`, name: pendingName };
    await create.click(); await input.fill(pendingName);
    // This command is held entirely in the browser. Its eventual fake result
    // must be ignored after the same panel reconnects to the same HA connection.
    await panel.evaluate((el, name) => {
      const hass = el.hass, original = hass.callWS;
      const test = window.__settingsDetachedTest = { hass, original, panel: el, connection: hass.connection, calls: 0, resolve: null, reject: null };
      hass.callWS = function (message) {
        if (message.type === 'config/area_registry/create' && message.name === name) {
          test.calls++; return new Promise((resolve, reject) => { test.resolve = resolve; test.reject = reject; });
        }
        return original.call(this, message);
      };
    }, pendingName);
    try {
      await input.press('Enter');
      await expect.poll(() => page.evaluate(() => window.__settingsDetachedTest.calls)).toBe(1);
      await expect(form).toHaveAttribute('aria-busy', 'true'); await expect(input).toBeDisabled();
      await panel.evaluate(el => {
        const parent = el.parentNode, next = el.nextSibling;
        el.remove(); parent.insertBefore(el, next);
      });
      assert.equal(await panel.evaluate(el => el === window.__settingsDetachedTest.panel
        && el.hass.connection === window.__settingsDetachedTest.connection && el.isConnected), true,
      'The exact same panel and HA connection are reused');
      await expect(dialog).toHaveCount(0); await openRooms(); await expectRoomList();
      await expect(create).toBeEnabled(); await expect(back).toBeEnabled();
      const toastBefore = await panel.locator('#toast').evaluate(el => ({ hidden: el.hidden, text: el.textContent }));
      await page.evaluate(async area => {
        const test = window.__settingsDetachedTest;
        test.hass.callWS = test.original; test.resolve(area); test.reject = null;
        // Let the old async save, including its finally block, fully settle.
        await new Promise(resolve => setTimeout(resolve, 0));
      }, fakeArea);
      await expect(title).toHaveText('Räume'); await expectRoomList();
      await expect(areaRow(fakeArea.area_id)).toHaveCount(0);
      assert.equal(await panel.evaluate((el, id) => el._registries.areas.some(area => (area.area_id || area.id) === id), fakeArea.area_id), false);
      assert.deepEqual(await panel.locator('#toast').evaluate(el => ({ hidden: el.hidden, text: el.textContent })), toastBefore,
        'The stale result does not show a success toast');
      await expect(create).toBeEnabled(); await expect(back).toBeEnabled();
      await create.click(); await expect(input).toBeEnabled(); await expect(save).toBeEnabled();
      await expect(input).toHaveValue(''); await expect(form).toHaveAttribute('aria-busy', 'false');
      await back.click(); await expect(title).toHaveText('Räume');
      assert.deepEqual(sorted(await ha.call('config/area_registry/list'), 'area_id'), before,
        'The intercepted create never reaches HA');
    } finally {
      await page.evaluate(() => {
        const test = window.__settingsDetachedTest;
        if (test) { test.hass.callWS = test.original; test.reject?.(new Error('Test: detached save cancelled.')); delete window.__settingsDetachedTest; }
      });
    }
  });

  await check('Neu creates one real HA area from the focused name form', async () => {
    await create.click(); await expect(form).toBeVisible(); await expect(input).toBeFocused();
    await expect(input).toHaveValue(''); await input.fill(createdName);
    await expect(save).toBeEnabled(); createAttempted = true; await save.click();
    await expect.poll(async () => {
      const matches = (await ha.call('config/area_registry/list')).filter(area => area.name === createdName);
      assert.ok(matches.length <= 1, 'Only one test area may be created');
      if (matches[0]) tempAreaId = matches[0].area_id;
      return Boolean(tempAreaId);
    }).toBe(true);
    assert.ok(!initialAreas.some(area => area.area_id === tempAreaId));
    await expect(title).toHaveText('Räume'); await expectRoomList();
    await expect(areaRow(tempAreaId)).toContainText(createdName);
    await expect(panel.locator('[data-settings-area]')).toHaveCount(initialAreas.length + 1);
    await dismiss(); await expect(panel.locator(`[data-room-card="${tempAreaId}"] h2`)).toHaveText(createdName);
  });

  await check('Editing the test room renames the same HA area and survives a full browser reload', async () => {
    await openRooms(); await areaRow(tempAreaId).click();
    await expect(form).toBeVisible(); await expect(input).toBeFocused(); await expect(input).toHaveValue(createdName);
    await input.fill(renamedName); await save.click();
    await expect.poll(async () => (await ha.call('config/area_registry/list')).find(area => area.area_id === tempAreaId)?.name).toBe(renamedName);
    await expect(title).toHaveText('Räume'); await expect(areaRow(tempAreaId)).toContainText(renamedName);
    await page.reload(); await panel.locator('.room-card').first().waitFor({ timeout: 30000 });
    await expect(panel.locator(`[data-room-card="${tempAreaId}"] h2`)).toHaveText(renamedName);
    await openRooms(); await expectRoomList(); await expect(areaRow(tempAreaId)).toContainText(renamedName);
    await areaRow(tempAreaId).click(); await expect(input).toHaveValue(renamedName);
    await back.click(); await expect(title).toHaveText('Räume');
  });

  await check('A duplicate name is rejected while preserving the draft and an accessible error', async () => {
    const before = sorted(await ha.call('config/area_registry/list'), 'area_id');
    await create.click(); await input.fill(renamedName); await save.click();
    await expect(form).toBeVisible(); await expect(input).toHaveValue(renamedName);
    await expect(alert).toBeVisible(); await expect(alert).toContainText(/bereits|existiert|vergeben/i);
    await expect(save).toBeEnabled();
    assert.deepEqual(sorted(await ha.call('config/area_registry/list'), 'area_id'), before, 'Duplicate submission does not add or alter an area');
    await screenshot('duplicate-error');
    await back.click(); await expect(title).toHaveText('Räume'); await expectRoomList();
  });

  await check('Invalid, oversized and corrupt image files show an error without uploading or losing the valid preview', async () => {
    const before = await ownArea(), imagesBefore = sorted(await ha.call('image/list'), 'id'), uploadCount = imageUploadRequests.length;
    await areaRow(tempAreaId).click(); await expect(input).toHaveValue(renamedName);
    await imageInput.setInputFiles({ name: `Easy-Hass Test ${suffix}.txt`, mimeType: 'text/plain', buffer: Buffer.from('This is not an image.') });
    await expect(imageError).toBeVisible(); await expect(imageError).toHaveAttribute('role', 'alert');
    await expect(imageError).toContainText(/bild|jpeg|png|gif|format/i);
    await expect(imagePreview).toHaveCount(0); await expect(input).toHaveValue(renamedName);
    await imageInput.setInputFiles({ name: imageFilename, mimeType: 'image/png', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
    await expect(imageError).toBeVisible(); await expect(imageError).toContainText(/10|groß|gross|größe|grösse|größe/i);
    await expect(imagePreview).toHaveCount(0);
    await chooseTestImage(); await expect(imageError).toHaveCount(0);
    const validPreview = await imagePreview.getAttribute('src');
    await imageInput.setInputFiles({ name: imageFilename, mimeType: 'image/png', buffer: Buffer.from('This is not valid PNG image data.') });
    await expect(imageError).toBeVisible(); await expect(imageError).toContainText(/nicht.*(?:gelesen|geladen)|beschädigt|ungültig/i);
    await expect(imagePreview).toHaveAttribute('src', validPreview);
    await expect.poll(() => imagePreview.evaluate(image => image.complete && image.naturalWidth === 96)).toBe(true);
    await expect(input).toHaveValue(renamedName); await expect(save).toBeEnabled();
    assert.equal(imageUploadRequests.length, uploadCount, 'Invalid selection does not start an image upload');
    assert.deepEqual(await ownArea(), before); assert.deepEqual(sorted(await ha.call('image/list'), 'id'), imagesBefore);
    await back.click(); await expect(title).toHaveText('Räume');
  });

  await check('Finishing a delayed image decode preserves the room name and its keyboard focus', async () => {
    const before = await ownArea(), imagesBefore = sorted(await ha.call('image/list'), 'id'), uploadCount = imageUploadRequests.length;
    const typedName = `Easy-Hass Test Langsam ${suffix} geprüft`;
    await areaRow(tempAreaId).click();
    await page.evaluate(() => {
      const original = Image.prototype.decode;
      const test = window.__settingsImageDecodeTest = { original, claimed: false, waiting: false, release: null };
      Image.prototype.decode = function (...args) {
        const decoded = original.apply(this, args);
        if (!this.src.startsWith('blob:') || test.claimed) return decoded;
        test.claimed = true;
        // Decode the real PNG first, then delay only delivery of its result.
        return decoded.then(() => new Promise(resolve => { test.waiting = true; test.release = resolve; }));
      };
    });
    try {
      await imageInput.setInputFiles({ name: imageFilename, mimeType: 'image/png', buffer: imageBuffer });
      await expect.poll(() => page.evaluate(() => window.__settingsImageDecodeTest.waiting)).toBe(true);
      await expect(form).toHaveAttribute('aria-busy', 'true'); await expect(save).toBeDisabled();
      await expect(input).toBeEnabled(); await input.focus();
      await input.fill(`Easy-Hass Test Langsam ${suffix}`); await input.pressSequentially(' geprüft');
      await expect(input).toHaveValue(typedName); await expect(input).toBeFocused();
      await page.evaluate(() => {
        const test = window.__settingsImageDecodeTest;
        Image.prototype.decode = test.original; test.release();
      });
      await expect(form).toHaveAttribute('aria-busy', 'false'); await expect(save).toBeEnabled();
      await expect(imagePreview).toBeVisible(); await expect(imagePreview).toHaveAttribute('src', /^blob:/);
      await expect.poll(() => imagePreview.evaluate(image => image.complete && image.naturalWidth === 96)).toBe(true);
      await expect(input).toBeFocused(); await expect(input).toHaveValue(typedName);
      assert.equal(imageUploadRequests.length, uploadCount, 'Decoding a selected image never uploads it');
      assert.deepEqual(await ownArea(), before); assert.deepEqual(sorted(await ha.call('image/list'), 'id'), imagesBefore);
    } finally {
      await page.evaluate(() => {
        const test = window.__settingsImageDecodeTest;
        if (test) { Image.prototype.decode = test.original; test.release?.(); delete window.__settingsImageDecodeTest; }
      });
    }
    await back.click(); await expect(title).toHaveText('Räume');
    assert.deepEqual(await ownArea(), before);
  });

  await check('Choosing an image previews it locally; cancelling discards the image and name draft without an upload', async () => {
    const before = await ownArea(), imagesBefore = sorted(await ha.call('image/list'), 'id'), uploadCount = imageUploadRequests.length;
    await areaRow(tempAreaId).click(); await expect(imageButton).toContainText('Bild hinzufügen');
    await chooseTestImage(); await expect(imageButton).toContainText('Bild ändern'); await expect(imageRemove).toBeVisible();
    await input.fill(`Easy-Hass Test Nicht speichern ${suffix}`);
    await screenshot('picture-preview-light');
    assert.equal(imageUploadRequests.length, uploadCount, 'Selecting a file only creates a browser-local preview');
    assert.deepEqual(await ownArea(), before); assert.deepEqual(sorted(await ha.call('image/list'), 'id'), imagesBefore);
    await back.click(); await expect(title).toHaveText('Räume'); await areaRow(tempAreaId).click();
    await expect(input).toHaveValue(renamedName); await expect(imagePreview).toHaveCount(0); await expect(imagePlaceholder).toBeVisible();
    assert.equal(imageUploadRequests.length, uploadCount, 'Cancelling never uploads the selected file');
    assert.deepEqual(await ownArea(), before); assert.deepEqual(sorted(await ha.call('image/list'), 'id'), imagesBefore);
    await back.click(); await expect(title).toHaveText('Räume');
  });

  await check('Saving uploads the chosen image and commits name plus picture to the same HA area across reload', async () => {
    const uploadCount = imageUploadRequests.length;
    await areaRow(tempAreaId).click(); await chooseTestImage(); await input.fill(photoName);
    assert.equal(imageUploadRequests.length, uploadCount, 'The file remains local until Save');
    const responsePromise = page.waitForResponse(response => isImageUpload(response.request()));
    await save.click(); const response = await responsePromise;
    assert.equal(response.ok(), true, 'HA accepts the actual multipart image upload');
    const image = await response.json();
    assert.ok(image.id && image.name === imageFilename && !initialImages.some(original => original.id === image.id));
    ownedImageIds.add(image.id);
    await expect.poll(async () => (await ownArea())?.name).toBe(photoName);
    await expect.poll(async () => (await ownArea())?.picture).toMatch(new RegExp(`^/api/image/serve/${image.id}/`));
    uploadedPicture = (await ownArea()).picture;
    assert.equal(imageUploadRequests.length, uploadCount + 1, 'One Save uploads the image exactly once');
    assert.ok((await ha.call('image/list')).some(item => item.id === image.id && item.name === imageFilename));
    await expect(title).toHaveText('Räume'); await expect(areaRow(tempAreaId)).toContainText(photoName);
    await page.reload(); await panel.locator('.room-card').first().waitFor({ timeout: 30000 });
    const card = panel.locator(`[data-room-card="${tempAreaId}"]`), cardImage = card.locator('img[data-room-picture]');
    await expect(card.locator('h2')).toHaveText(photoName); await card.scrollIntoViewIfNeeded();
    await expect(cardImage).toHaveAttribute('src', new RegExp(uploadedPicture));
    await expect.poll(() => cardImage.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    await openRooms(); await areaRow(tempAreaId).click(); await expect(input).toHaveValue(photoName);
    await expect(imagePreview).toBeVisible(); await expect(imagePreview).toHaveAttribute('src', new RegExp(uploadedPicture));
    await theme('dark'); await screenshot('picture-saved-dark'); await theme('light');
    await back.click(); await expect(title).toHaveText('Räume');
  });

  await check('Removing a room image is staged until Save; cancel preserves it and saving persists the removal', async () => {
    const before = await ownArea(), imagesBefore = sorted(await ha.call('image/list'), 'id'), uploadCount = imageUploadRequests.length;
    assert.equal(before.picture, uploadedPicture);
    await areaRow(tempAreaId).click(); await imageRemove.click();
    await expect(imagePreview).toHaveCount(0); await expect(imagePlaceholder).toBeVisible();
    assert.deepEqual(await ownArea(), before, 'The remove control only changes the draft');
    assert.deepEqual(sorted(await ha.call('image/list'), 'id'), imagesBefore, 'Staging a removal does not delete the image asset');
    await back.click(); await expect(title).toHaveText('Räume'); await areaRow(tempAreaId).click();
    await expect(imagePreview).toHaveAttribute('src', new RegExp(uploadedPicture));
    await expect.poll(() => imagePreview.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    assert.deepEqual(await ownArea(), before, 'Cancelling a staged removal preserves the actual picture');
    assert.deepEqual(sorted(await ha.call('image/list'), 'id'), imagesBefore);
    await imageRemove.click(); await save.click();
    await expect.poll(async () => (await ownArea())?.picture ?? null).toBe(null);
    assert.equal((await ownArea()).name, photoName, 'Removing the image preserves the saved room name');
    assert.equal(imageUploadRequests.length, uploadCount, 'Removing an image does not upload another asset');
    await expect(title).toHaveText('Räume'); await page.reload();
    await panel.locator('.room-card').first().waitFor({ timeout: 30000 });
    await expect(panel.locator(`[data-room-card="${tempAreaId}"] img[data-room-picture]`)).toHaveCount(0);
    await expect(panel.locator(`[data-room-card="${tempAreaId}"] .room-picture`)).toHaveClass(/no-picture/);
    await openRooms(); await areaRow(tempAreaId).click();
    await expect(imagePreview).toHaveCount(0); await expect(imagePlaceholder).toBeVisible();
    await expect(input).toHaveValue(photoName); await back.click(); await expect(title).toHaveText('Räume');
  });

  await check('Dark and small-screen settings remain usable with focus kept inside the sheet', async () => {
    await theme('dark'); await screenshot('rooms-dark');
    await page.setViewportSize({ width: 320, height: 568 }); await create.click();
    await expect(input).toBeFocused(); await input.fill(`Easy-Hass Test Entwurf ${suffix}`);
    const focusableCount = await dialog.evaluate(el => [...el.querySelectorAll('button, a[href], input, select, textarea')]
      .filter(node => !node.disabled && node.getClientRects().length).length);
    assert.ok(focusableCount >= 2, 'The form has usable keyboard controls');
    for (const key of ['Tab', 'Shift+Tab']) for (let i = 0; i <= focusableCount; i++) {
      await page.keyboard.press(key); await assertFocusContained();
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const box = await dialog.boundingBox(); assert.ok(box.x >= -1 && box.x + box.width <= 321, 'The sheet fits the narrow viewport');
    await input.scrollIntoViewIfNeeded(); await expect(input).toBeInViewport();
    await save.scrollIntoViewIfNeeded(); await expect(save).toBeInViewport();
    await screenshot('form-small-dark'); await dismiss();
    await page.setViewportSize({ width: 390, height: 852 });
    await openRooms(); await expectRoomList();
  });

  await check('Only the owned test area changed; device registries and fixture states are untouched', async () => {
    const remaining = (await ha.call('config/area_registry/list')).filter(area => area.area_id !== tempAreaId);
    assert.deepEqual(sorted(remaining, 'area_id'), sorted(initialAreas, 'area_id'));
    assert.deepEqual(sorted(await ha.call('config/device_registry/list'), 'id'), sorted(initialDevices, 'id'));
    assert.deepEqual(sorted(await ha.call('config/entity_registry/list'), 'entity_id'), sorted(initialEntities, 'entity_id'));
    await Promise.all(imageResponseTasks);
    assert.deepEqual(sorted((await ha.call('image/list')).filter(image => !ownedImageIds.has(image.id)), 'id'), sorted(initialImages, 'id'),
      'Existing uploaded images are untouched');
    assert.equal(fingerprint((await ha.call('get_states')).filter(state => fixtureIds.has(state.entity_id))), initialStates);
    assert.deepEqual(serviceCalls, [], 'Settings did not invoke device services');
    assert.deepEqual(report.errors, [], 'No uncaught browser errors');
  });
} catch (error) {
  failure = error;
  if (!report.results.some(result => !result.pass)) report.errors.push(error.stack || String(error));
  if (page) await page.screenshot({ path: 'test-results/settings-failure.png' }).catch(() => {});
} finally {
  const cleanup = async run => { try { await run(); } catch (error) { report.errors.push(`Cleanup: ${error.message}`); } };
  if (ha && createAttempted && !tempAreaId) await cleanup(async () => {
    // Recover the ID if UI assertions failed after creation. Require both this
    // connection's create event and the unique name before accepting ownership.
    const candidates = (await ha.call('config/area_registry/list')).filter(area => areaCreateEvents.has(area.area_id)
      && !initialAreas.some(original => original.area_id === area.area_id) && ownedNames.has(area.name));
    assert.ok(candidates.length <= 1, 'Ambiguous test area ownership');
    if (candidates[0]) tempAreaId = candidates[0].area_id;
  });
  if (ha && tempAreaId) await cleanup(async () => {
    const own = (await ha.call('config/area_registry/list')).find(area => area.area_id === tempAreaId);
    if (!own) return;
    assert.ok(!initialAreas.some(area => area.area_id === tempAreaId) && ownedNames.has(own.name)
      && own.name.startsWith('Easy-Hass Test '), 'Only delete this run’s known test area ID');
    await ha.call('config/area_registry/delete', { area_id: tempAreaId });
    assert.ok(!(await ha.call('config/area_registry/list')).some(area => area.area_id === tempAreaId));
    report.cleanup = { deletedAreaId: tempAreaId, originalsPreserved: true };
  });
  if (ha && initialImages) await cleanup(async () => {
    await Promise.all(imageResponseTasks);
    const images = await ha.call('image/list');
    // Recover an upload that succeeded just before a UI assertion failed. Its
    // unique filename, a request from this browser, and an absent baseline ID
    // all have to agree before we accept ownership and delete it.
    if (imageUploadRequests.length) for (const image of images) {
      if (ownedImageNames.has(image.name) && !initialImages.some(original => original.id === image.id)) ownedImageIds.add(image.id);
    }
    const areas = await ha.call('config/area_registry/list'), deletedImageIds = [];
    for (const id of ownedImageIds) {
      const own = images.find(image => image.id === id);
      if (!own) continue; // The app may already have removed an unused upload.
      assert.ok(ownedImageNames.has(own.name) && !initialImages.some(image => image.id === id), 'Only delete this run’s known image IDs');
      assert.ok(!areas.some(area => area.picture?.includes(`/api/image/serve/${id}/`)), 'An uploaded image must be unreferenced before cleanup');
      await ha.call('image/delete', { image_id: id }); deletedImageIds.push(id);
    }
    assert.deepEqual(sorted(await ha.call('image/list'), 'id'), sorted(initialImages, 'id'), 'No test uploads remain and original images are preserved');
    report.cleanup = { ...report.cleanup, deletedImageIds, originalImagesPreserved: true };
  });
  if (page && appearance) await cleanup(() => page.locator('easy-hass-panel').evaluate((el, saved) => {
    if (saved.value === null) localStorage.removeItem(saved.key); else localStorage.setItem(saved.key, saved.value);
    el._applyTheme();
  }, appearance));
  if (browser) await cleanup(() => browser.close()); ha?.close();
  report.haServiceCalls = serviceCalls.length;
  report.imageUploadRequests = imageUploadRequests.length;
  await writeFile('test-results/browser-settings.json', `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.results.filter(result => result.pass).length, report: 'test-results/browser-settings.json', haServiceCalls: serviceCalls.length }));
if (failure) throw failure;
if (report.errors.length) throw new Error('Settings checks reported browser or cleanup errors; see report');
