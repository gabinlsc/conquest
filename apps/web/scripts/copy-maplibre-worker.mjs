// MapLibre v6 charge son worker via une URL : les bundlers (Turbopack) ne la résolvent pas.
// On copie les fichiers worker dans public/ (ignoré par git) et on appelle setWorkerUrl().
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(require.resolve('maplibre-gl/package.json')), 'dist');
const out = path.join(import.meta.dirname, '..', 'public', 'maplibre');
mkdirSync(out, { recursive: true });
for (const f of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
  copyFileSync(path.join(dist, f), path.join(out, f));
}
