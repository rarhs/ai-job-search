// Stages store-ready builds into dist/chrome and dist/firefox (plus zips when
// the `zip` CLI is available). Zero dependencies; run with: node build.mjs
//
// Transformations relative to the source (Chrome dev) manifest:
// - both: drop http://localhost / http://127.0.0.1 host permissions (test-only)
// - firefox: background.scripts event page (no service-worker support),
//   browser_specific_settings.gecko id + min version
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(SRC, 'dist');
const SHIPPED = ['background.js', 'lib', 'content', 'popup', 'options'];

const isTestOnly = (perm) =>
  perm.startsWith('http://localhost') || perm.startsWith('http://127.0.0.1');

function chromeManifest(manifest) {
  return {
    ...manifest,
    host_permissions: manifest.host_permissions.filter((p) => !isTestOnly(p)),
  };
}

function firefoxManifest(manifest) {
  return {
    ...chromeManifest(manifest),
    background: { scripts: ['background.js'] },
    browser_specific_settings: {
      gecko: { id: 'jobfit@ai-job-search', strict_min_version: '121.0' },
    },
  };
}

async function stage(name, transform) {
  const dir = path.join(DIST, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const entry of SHIPPED) {
    await cp(path.join(SRC, entry), path.join(dir, entry), { recursive: true });
  }
  const manifest = JSON.parse(await readFile(path.join(SRC, 'manifest.json'), 'utf8'));
  await writeFile(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify(transform(manifest), null, 2)}\n`);

  try {
    await rm(path.join(DIST, `${name}.zip`), { force: true });
    await promisify(execFile)('zip', ['-r', '-q', `../${name}.zip`, '.'], { cwd: dir });
    console.log(`built dist/${name}/ and dist/${name}.zip`);
  } catch {
    console.log(`built dist/${name}/ (zip CLI not found, skipped archive)`);
  }
}

await stage('chrome', chromeManifest);
await stage('firefox', firefoxManifest);
