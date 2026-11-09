import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  // Le package partagé est compilé dans le bundle ; les autres deps restent externes
  // (installées en prod via `pnpm deploy --prod`).
  noExternal: ['@conquest/shared'],
});
