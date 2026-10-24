/** Verify links to real native HA panels and the loaded Easy-Hass release. */
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { localBrowser } from './browser-login.mjs';
import { LocalHA, baseUrl } from './ha-client.mjs';

const ha = await LocalHA.open();
const { browser, page } = await localBrowser({ viewport: { width: 1280, height: 900 } });
const results = [];
try {
  const panels = await ha.call('get_panels');
  const moduleUrl = panels['easy-hass']?.config?._panel_custom?.module_url;
  const build = JSON.parse(await readFile(new URL('../custom_components/easy_hass/frontend/build.json', import.meta.url), 'utf8'));
  assert.equal(moduleUrl, `/easy_hass_static/${build.entry}`, 'Running integration registers the current immutable frontend build');
  const served = await fetch(new URL(moduleUrl, baseUrl)).then(response => {
    assert.ok(response.ok); return response.text();
  });
  const source = await readFile(new URL('../frontend/src/easy-hass.js', import.meta.url), 'utf8');
  assert.equal(served, source, 'HA serves the current Easy-Hass source');
  results.push({ name: 'Running HA serves the current fingerprinted frontend bytes', pass: true });
  for (const tab of ['map', 'energy']) {
    assert.ok(panels[tab], `Native HA ${tab} panel is registered`);
    // Current HA exposes Map as a native Lovelace dashboard, not ha-panel-map.
    const component = `ha-panel-${panels[tab].component_name}`;
    await page.locator(`[data-tab="${tab}"]`).click();
    await expect(page).toHaveURL(`${baseUrl}/${tab}`);
    await expect(page.locator(component)).toBeVisible({ timeout: 30000 });
    await page.locator('#ha-launch-screen').waitFor({ state: 'detached', timeout: 10000 });
    if (tab === 'map') await expect(page.getByRole('region', { name: 'Map', exact: true })).toBeVisible({ timeout: 30000 });
    else await expect(page.locator(component).getByRole('button').first()).toBeVisible({ timeout: 30000 });
    await expect(page.locator('ha-sidebar')).toBeVisible();
    await page.screenshot({ path: `test-results/native-${tab}.png` });
    results.push({ name: `Easy-Hass opens the actual native HA ${tab} panel and restores navigation`, pass: true });
    await page.goto(`${baseUrl}/easy-hass`);
    await page.locator('easy-hass-panel .room-card').first().waitFor({ timeout: 30000 });
  }
} finally {
  await browser.close();
  ha.close();
  await writeFile(new URL('../test-results/browser-panels.json', import.meta.url), `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: results.length, report: 'test-results/browser-panels.json' }));
