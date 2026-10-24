import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

test('page reconciliation preserves controls, pictures and focus while applying live HA updates', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const source = await readFile(new URL('../frontend/src/dom.js', import.meta.url), 'utf8');
    await page.addScriptTag({ type: 'module', content: `${source}\nwindow.updateMarkup = updateMarkup;` });
    await page.waitForFunction(() => typeof window.updateMarkup === 'function');
    const result = await page.evaluate(async () => {
      const parent = document.createElement('main');
      document.body.append(parent);
      const room = (id, name, on, cover = true) => `<article data-room-card="${id}" class="room"><h2>${name}</h2><div class="picture"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" alt=""></div><div class="controls">${cover ? `<button data-control="cover" data-room="${id}">Cover</button>` : ''}<button data-control="light" data-room="${id}" aria-pressed="${on}" ${on ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${on ? 'M2 2h4' : 'M1 1h2'}"/></svg></button></div></article>`;
      const robot = (id, actions) => `<section>${actions.map(action => `<button data-vacuum="${id}" data-action="${action}">${action}</button>`).join('')}</section>`;
      window.updateMarkup(parent, `<div class="grid">${room('a', 'A', false)}${room('b', 'B', false)}</div>${robot('vacuum.bot', ['start', 'stop'])}`);
      const a = parent.querySelector('[data-room-card="a"]');
      const b = parent.querySelector('[data-room-card="b"]');
      const light = a.querySelector('[data-control="light"]');
      const path = light.querySelector('path');
      const image = a.querySelector('img');
      const stop = parent.querySelector('[data-action="stop"]');
      let clicked = 0;
      stop.addEventListener('click', () => clicked++);
      stop.focus();
      const changedImageAttributes = [];
      const observer = new MutationObserver(records => changedImageAttributes.push(...records.map(record => record.attributeName)));
      observer.observe(image, { attributes: true });
      window.updateMarkup(parent, `<div class="grid">${room('b', 'B renamed', false)}${room('a', 'A &amp; &lt;script&gt; &quot;quoted&quot;', true, false)}</div>${robot('vacuum.bot', ['stop', 'pause'])}`);
      await Promise.resolve();
      observer.disconnect();
      const afterUpdate = {
        roomsPreserved: parent.querySelector('[data-room-card="a"]') === a && parent.querySelector('[data-room-card="b"]') === b,
        order: [...parent.querySelectorAll('[data-room-card]')].map(node => node.dataset.roomCard),
        controlPreserved: a.querySelector('[data-control="light"]') === light,
        removedControl: !a.querySelector('[data-control="cover"]'),
        disabledAdded: light.disabled && light.getAttribute('aria-pressed') === 'true',
        pathPreserved: light.querySelector('path') === path,
        svgUpdated: path.getAttribute('d') === 'M2 2h4' && path.namespaceURI === 'http://www.w3.org/2000/svg' && light.querySelector('svg').getAttribute('viewBox') === '0 0 24 24',
        text: a.querySelector('h2').textContent,
        noScript: !parent.querySelector('script'),
        imagePreserved: a.querySelector('img') === image,
        imageAttributesUntouched: changedImageAttributes.length === 0,
        robotPreserved: parent.querySelector('[data-action="stop"]') === stop,
        focusPreserved: document.activeElement === stop,
      };
      stop.click();
      window.updateMarkup(parent, `<div class="grid">${room('a', 'A', false, false)}</div>${robot('vacuum.bot', ['stop'])}`);
      return { ...afterUpdate, listenerPreserved: clicked === 1, removedRoom: !b.isConnected, disabledRemoved: !light.disabled && !light.hasAttribute('disabled'), remainingRoomPreserved: a.isConnected };
    });
    assert.deepEqual(result.order, ['b', 'a']);
    assert.equal(result.text, 'A & <script> "quoted"');
    for (const [name, value] of Object.entries(result)) {
      if (name !== 'order' && name !== 'text') assert.equal(value, true, name);
    }
  } finally {
    await browser.close();
  }
});
