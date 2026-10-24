import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildFrontend } from '../scripts/build.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'easy-hass-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'frontend/src');
  await mkdir(path.join(source, 'assets'), { recursive: true });
  await writeFile(path.join(source, 'easy-hass.js'), "import './model.js';\n");
  await writeFile(path.join(source, 'model.js'), 'export const value = 1;\n');
  await writeFile(path.join(source, 'panel.css'), 'body { color: black; }\n');
  await writeFile(path.join(source, 'assets/font.woff2'), Buffer.from([0, 1, 2, 3]));
  return { root, source, output: path.join(root, 'custom_components/easy_hass/frontend') };
}

test('build is deterministic and the full asset graph shares one fingerprinted path', async t => {
  const { root, output } = await fixture(t);
  const first = await buildFrontend({ root });
  const second = await buildFrontend({ root });
  assert.deepEqual(second, first);
  assert.match(first.revision, /^[0-9a-f]{64}$/);
  assert.equal(first.entry, `builds/${first.revision}/easy-hass.js`);
  assert.deepEqual(await buildFrontend({ root, check: true }), first);
  const url = new URL(first.entry, 'http://localhost/easy_hass_static/');
  for (const file of first.files) {
    assert.ok(new URL(`./${file}`, url).pathname.startsWith(`/easy_hass_static/builds/${first.revision}/`));
    assert.ok((await readFile(path.join(output, `builds/${first.revision}`, file))).length);
  }
});

test('CSS, dependency, font and file-list changes all replace the graph URL and remove stale output', async t => {
  const { root, source, output } = await fixture(t);
  let previous = await buildFrontend({ root });
  for (const [file, value] of [['panel.css', 'body { color: red; }'], ['model.js', 'export const value = 2;'], ['assets/font.woff2', 'new font'], ['extra.js', 'export const added = true;']]) {
    await writeFile(path.join(source, file), value);
    await assert.rejects(buildFrontend({ root, check: true }));
    const current = await buildFrontend({ root });
    assert.notEqual(current.revision, previous.revision, file);
    assert.deepEqual((await readdir(path.join(output, 'builds'))), [current.revision]);
    previous = current;
  }
  await rm(path.join(source, 'extra.js'));
  const current = await buildFrontend({ root });
  assert.notEqual(current.revision, previous.revision);
  assert.deepEqual((await readdir(output)).sort(), ['build.json', 'builds']);
});

test('check rejects altered bytes, metadata and extraneous generated files', async t => {
  const { root, output } = await fixture(t);
  let metadata = await buildFrontend({ root });
  await writeFile(path.join(output, metadata.entry), 'stale module');
  await assert.rejects(buildFrontend({ root, check: true }), /Build veraltet/);
  metadata = await buildFrontend({ root });
  await writeFile(path.join(output, 'build.json'), JSON.stringify({ ...metadata, entry: '../wrong.js' }));
  await assert.rejects(buildFrontend({ root, check: true }), /Build veraltet/);
  await buildFrontend({ root });
  await writeFile(path.join(output, 'easy-hass.js'), 'legacy root asset');
  await assert.rejects(buildFrontend({ root, check: true }), /Build-Dateien/);
  await buildFrontend({ root });
  await buildFrontend({ root, check: true });
});
