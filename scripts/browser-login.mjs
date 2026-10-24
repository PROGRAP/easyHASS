/** Open the actual local HA login. Never prints passwords or session tokens. */
import { chromium } from '@playwright/test';
import { readFile, mkdir, chmod } from 'node:fs/promises';
import { baseUrl } from './ha-client.mjs';

export async function localBrowser(options = {}) {
  const { headless = true, ...contextOptions } = options;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 390, height: 852 }, ...contextOptions });
  const auth = JSON.parse(await readFile(new URL('../.local-ha/auth.json', import.meta.url), 'utf8'));
  if (auth.url !== baseUrl) throw new Error('Only the isolated local HA may be tested.');
  const page = await context.newPage();
  await page.goto(`${baseUrl}/easy-hass`);
  const username = page.locator('input[name="username"]');
  await username.waitFor({ timeout: 30000 });
  await username.fill(auth.username);
  await page.locator('input[name="password"]').fill(auth.password);
  await page.locator('input[name="password"]').press('Enter');
  await page.locator('easy-hass-panel').waitFor({ timeout: 30000 });
  await page.locator('easy-hass-panel .room-card').first().waitFor({ timeout: 30000 });
  await page.locator('#ha-launch-screen').waitFor({ state: 'detached', timeout: 10000 });
  await page.evaluate(() => document.fonts.ready);
  await context.storageState({ path: new URL('../.local-ha/browser-state.json', import.meta.url).pathname });
  await chmod(new URL('../.local-ha/browser-state.json', import.meta.url), 0o600);
  return { browser, context, page };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const show = process.argv.includes('--open');
  const { browser, page } = await localBrowser({ headless: !show });
  if (show) {
    console.log('Easy-Hass ist geöffnet und lokal angemeldet. Zum Beenden das Browserfenster schließen.');
    await new Promise(resolve => browser.on('disconnected', resolve));
  } else {
    try {
      await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
      await page.screenshot({ path: new URL('../test-results/first-live.png', import.meta.url).pathname, fullPage: true });
      console.log(JSON.stringify({ title: await page.title(), rooms: await page.locator('.room-card h2').allTextContents(), fontLoaded: await page.evaluate(() => document.fonts.check('17px EasyHassInter')) }));
    } finally { await browser.close(); }
  }
}
