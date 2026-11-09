// Réduit Natural Earth 50m admin_0 en un GeoJSON léger pour le fond de carte (hors-ligne).
// Usage : node scripts/build-countries.mjs <ne_50m_admin_0_countries.geojson> <sortie.json>
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: build-countries.mjs <in> <out>');

const round = (n) => Math.round(n * 100) / 100;
const roundCoords = (c) => (typeof c[0] === 'number' ? c.map(round) : c.map(roundCoords));

const src = JSON.parse(readFileSync(input, 'utf8'));
const features = src.features.map((f) => ({
  type: 'Feature',
  properties: {
    code: f.properties.ISO_A2_EH !== '-99' ? f.properties.ISO_A2_EH : f.properties.ISO_A2,
    name: f.properties.NAME,
  },
  geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) },
}));
writeFileSync(output, JSON.stringify({ type: 'FeatureCollection', features }));
