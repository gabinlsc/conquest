import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'cli/import-geonames': 'src/cli/import-geonames.ts',
    'cli/anticheat': 'src/cli/anticheat.ts',
  },
  format: ['esm'],
  target: 'node22',
  clean: true,
  // Le package partagé est compilé dans le bundle ; les autres deps restent externes
  // (installées en prod via `pnpm deploy --prod`).
  noExternal: ['@conquest/shared'],
});
