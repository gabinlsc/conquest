/** Mini jeu de données au format GeoNames, pour les tests (sans réseau). */
const city = (
  id: number,
  name: string,
  ascii: string,
  lat: number,
  lon: number,
  cc: string,
  a1: string,
  pop: number,
) =>
  [
    id,
    name,
    ascii,
    '',
    lat,
    lon,
    'P',
    'PPL',
    cc,
    '',
    a1,
    '',
    '',
    '',
    pop,
    '',
    0,
    'Europe/Paris',
    '2024-01-01',
  ].join('\t');

export const FIXTURE_CITIES = [
  city(2988507, 'Paris', 'Paris', 48.85341, 2.3488, 'FR', 'A8', 2138551),
  city(2996944, 'Lyon', 'Lyon', 45.74846, 4.84671, 'FR', 'A8', 472317),
  city(2995469, 'Marseille', 'Marseille', 43.29695, 5.38107, 'FR', 'B8', 870731),
  city(2950159, 'Berlin', 'Berlin', 52.52437, 13.41053, 'DE', '16', 3426354),
  city(5128581, 'New York City', 'New York City', 40.71427, -74.00597, 'US', 'NY', 8175133),
  city(1850147, 'Tokyo', 'Tokyo', 35.6895, 139.69171, 'JP', '40', 8336599),
  city(3128760, 'Sant Cugat del Vallès', 'Sant Cugat del Valles', 41.47, 2.08, 'ES', '56', 85000),
].join('\n');

export const FIXTURE_COUNTRIES = [
  '# commentaire',
  ['FR', 'FRA', '250', 'FR', 'France', 'Paris', '547030', '64768389', 'EU'].join('\t'),
  ['DE', 'DEU', '276', 'GM', 'Germany', 'Berlin', '357021', '82927922', 'EU'].join('\t'),
  ['US', 'USA', '840', 'US', 'United States', 'Washington', '9629091', '327167434', 'NA'].join(
    '\t',
  ),
  ['JP', 'JPN', '392', 'JA', 'Japan', 'Tokyo', '377835', '126529100', 'AS'].join('\t'),
  ['ES', 'ESP', '724', 'SP', 'Spain', 'Madrid', '504782', '46723749', 'EU'].join('\t'),
].join('\n');

export const FIXTURE_ADMIN1 =
  "FR.A8\tProvence-Alpes-Côte d'Azur\tProvence\t1\nFR.B8\tAuvergne-Rhône-Alpes\tAuvergne\t2\n";
