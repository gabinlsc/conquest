import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Les tests d'intégration repartent d'une base vide (DROP SCHEMA) : ils ne doivent pas tourner en parallèle.
    fileParallelism: false,
  },
});
