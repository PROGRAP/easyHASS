import { mkdir, readFile, writeFile, readdir, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
async function listFiles(directory, prefix = '', skipHidden = true) {
  const files = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    if (skipHidden && entry.name.startsWith('.')) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(directory, relative, skipHidden));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

/** One immutable URL namespace for the entire JS/CSS/font graph. */
export async function buildFrontend({ root = projectRoot, check = false } = {}) {
  const sourceDirectory = path.join(root, 'frontend/src');
  const outputDirectory = path.join(root, 'custom_components/easy_hass/frontend');
  const files = await listFiles(sourceDirectory);
  if (!files.includes('easy-hass.js')) throw new Error('Frontend-Einstieg easy-hass.js fehlt.');
  const sources = new Map();
  const hash = createHash('sha256');
  for (const file of files) {
    const source = await readFile(path.join(sourceDirectory, file));
    sources.set(file, source);
    hash.update(`${file}\0${source.length}\0`);
    hash.update(source);
  }
  const revision = hash.digest('hex');
  const metadata = { schema_version: 1, revision, entry: `builds/${revision}/easy-hass.js`, files };
  const manifest = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
  const expected = new Map([['build.json', manifest], ...files.map(file => [`builds/${revision}/${file}`, sources.get(file)])]);
  if (check) {
    const actualFiles = await listFiles(outputDirectory, '', false);
    if (JSON.stringify(actualFiles.sort()) !== JSON.stringify([...expected.keys()].sort())) {
      throw new Error('Build-Dateien oder Fingerprint veraltet. Bitte npm run build ausführen.');
    }
    for (const [file, source] of expected) {
      if (!source.equals(await readFile(path.join(outputDirectory, file)))) {
        throw new Error(`Build veraltet: ${file}. Bitte npm run build ausführen.`);
      }
    }
    return metadata;
  }

  // Prepare the complete graph before replacing generated output; no duplicate
  // legacy root assets or obsolete build revisions enter the installation ZIP.
  const stage = path.join(path.dirname(outputDirectory), `.frontend-build-${randomUUID()}`);
  const previous = `${stage}-previous`;
  let movedPrevious = false;
  try {
    for (const [file, source] of expected) {
      const target = path.join(stage, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source);
    }
    try { await rename(outputDirectory, previous); movedPrevious = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(stage, outputDirectory); }
    catch (error) {
      if (movedPrevious) { await rename(previous, outputDirectory); movedPrevious = false; }
      throw error;
    }
    if (movedPrevious) await rm(previous, { recursive: true, force: true });
  } finally { await rm(stage, { recursive: true, force: true }); }
  return metadata;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const metadata = await buildFrontend({ check });
  console.log(`${check ? 'Frontend-Build ist aktuell' : 'Frontend mit vollständigem Asset-Fingerprint erstellt'}: ${metadata.revision.slice(0, 12)}.`);
}
