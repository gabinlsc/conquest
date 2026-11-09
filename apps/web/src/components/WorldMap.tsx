'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import * as maplibregl from 'maplibre-gl';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { City, Faction, WorldState } from '@conquest/shared';
import { fetchCitiesGeoJson, fetchCity, fetchWorldState } from '@/lib/api';
import { NEUTRAL_COLOR, baseStyle, radiusExpression } from '@/lib/mapStyle';
import { CityPanel } from './CityPanel';
import { SearchBox } from './SearchBox';
import { AccountMenu } from './AccountMenu';
import { useAuth } from './AuthProvider';
import { OnboardingModal } from './OnboardingModal';

// Worker servi depuis /public (copié par scripts/copy-maplibre-worker.mjs).
maplibregl.setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');

const SRC = 'cities';

type Status = 'loading' | 'ready' | 'error';

export default function WorldMap() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const factionsRef = useRef<Map<number, Faction>>(new Map());
  const selectedRef = useRef<number | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<{ cities: number; factions: number } | null>(null);
  const [selected, setSelected] = useState<City | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { me, status: authStatus } = useAuth();
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [forceOnboarding, setForceOnboarding] = useState(false);

  /** Applique les propriétaires via feature-state : aucun rechargement de la source GeoJSON. */
  const applyOwners = useCallback((map: maplibregl.Map, state: WorldState) => {
    factionsRef.current = new Map(state.factions.map((f) => [f.id, f]));
    for (const [cityId, factionId] of Object.entries(state.owners)) {
      const color = factionsRef.current.get(factionId)?.color;
      if (color) map.setFeatureState({ source: SRC, id: Number(cityId) }, { color });
    }
  }, []);

  const select = useCallback(async (id: number, fly = false) => {
    const map = mapRef.current;
    if (!map) return;
    const prev = selectedRef.current;
    if (prev !== null) map.setFeatureState({ source: SRC, id: prev }, { selected: false });
    selectedRef.current = id;
    map.setFeatureState({ source: SRC, id }, { selected: true });
    try {
      const city = await fetchCity(id);
      if (selectedRef.current !== id) return; // l'utilisateur a cliqué ailleurs entre-temps
      setSelected(city);
      if (fly)
        map.flyTo({ center: [city.lon, city.lat], zoom: Math.max(map.getZoom(), 7), speed: 1.4 });
    } catch {
      setSelected(null);
    }
  }, []);

  const clearSelection = useCallback(() => {
    const map = mapRef.current;
    if (map && selectedRef.current !== null) {
      map.setFeatureState({ source: SRC, id: selectedRef.current }, { selected: false });
    }
    selectedRef.current = null;
    setSelected(null);
  }, []);

  useEffect(() => {
    if (!container.current) return;
    const abort = new AbortController();
    setStatus('loading');
    setError(null);

    const map = new maplibregl.Map({
      container: container.current,
      style: baseStyle,
      center: [10, 30],
      zoom: 1.8,
      minZoom: 1,
      maxZoom: 14,
      attributionControl: {
        customAttribution:
          'Villes © <a href="https://www.geonames.org">GeoNames</a> (CC BY 4.0) · Frontières © Natural Earth',
      },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });

    map.on('load', () => {
      Promise.all([fetchCitiesGeoJson(abort.signal), fetchWorldState(abort.signal)])
        .then(([geojson, world]) => {
          // Clustering natif MapLibre sur la source GeoJSON ; au-delà de clusterMaxZoom,
          // chaque ville devient un point individuel.
          map.addSource(SRC, {
            type: 'geojson',
            data: geojson,
            cluster: true,
            clusterRadius: 48,
            clusterMaxZoom: 6,
          });

          map.addLayer({
            id: 'clusters',
            type: 'circle',
            source: SRC,
            filter: ['has', 'point_count'],
            paint: {
              'circle-color': [
                'step',
                ['get', 'point_count'],
                '#2f5d9e',
                50,
                '#6a4fb3',
                300,
                '#b0457a',
              ],
              'circle-opacity': 0.82,
              'circle-radius': ['step', ['get', 'point_count'], 13, 20, 17, 100, 22, 400, 28],
              'circle-stroke-color': '#ffffff',
              'circle-stroke-opacity': 0.35,
              'circle-stroke-width': 1,
            },
          });
          map.addLayer({
            id: 'cluster-count',
            type: 'symbol',
            source: SRC,
            filter: ['has', 'point_count'],
            layout: {
              'text-field': ['get', 'point_count_abbreviated'],
              'text-font': ['Open Sans Regular'],
              'text-size': 12,
              'text-allow-overlap': true,
            },
            paint: { 'text-color': '#ffffff' },
          });
          map.addLayer({
            id: 'city-points',
            type: 'circle',
            source: SRC,
            filter: ['!', ['has', 'point_count']],
            paint: {
              // Couleur data-driven : lue dans le feature-state (poussé depuis /world/state, puis par les deltas temps réel).
              'circle-color': ['coalesce', ['feature-state', 'color'], NEUTRAL_COLOR],
              'circle-radius': radiusExpression(),
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': [
                'case',
                ['boolean', ['feature-state', 'selected'], false],
                2.5,
                0.6,
              ],
              'circle-stroke-opacity': [
                'case',
                ['boolean', ['feature-state', 'selected'], false],
                1,
                0.45,
              ],
            },
          });
          map.addLayer({
            id: 'city-labels',
            type: 'symbol',
            source: SRC,
            minzoom: 4.5,
            filter: ['!', ['has', 'point_count']],
            layout: {
              'text-field': ['get', 'label'],
              'text-font': ['Open Sans Regular'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 10, 13],
              'text-offset': [0, 1],
              'text-anchor': 'top',
              // Les plus grosses villes gagnent les collisions de labels.
              'symbol-sort-key': ['-', 0, ['get', 'pop']],
              'text-optional': true,
            },
            paint: {
              'text-color': '#dbe3f5',
              'text-halo-color': '#070b17',
              'text-halo-width': 1.4,
            },
          });

          applyOwners(map, world);
          setCounts({ cities: geojson.features.length, factions: world.factions.length });
          setStatus('ready');
        })
        .catch((err: unknown) => {
          if (abort.signal.aborted) return;
          setError(err instanceof Error ? err.message : 'chargement impossible');
          setStatus('error');
        });
    });

    map.on('click', 'clusters', (e) => {
      const feature = e.features?.[0];
      if (!feature || feature.geometry.type !== 'Point') return;
      const center = feature.geometry.coordinates as [number, number];
      const clusterId = feature.properties['cluster_id'] as number;
      (map.getSource(SRC) as maplibregl.GeoJSONSource)
        .getClusterExpansionZoom(clusterId)
        .then((zoom) => map.easeTo({ center, zoom: zoom + 0.5 }))
        .catch(() => undefined);
    });
    map.on('click', 'city-points', (e) => {
      const id = e.features?.[0]?.id;
      if (typeof id === 'number') void select(id);
    });
    map.on('click', (e) => {
      if (!map.queryRenderedFeatures(e.point, { layers: ['city-points', 'clusters'] }).length) {
        clearSelection();
      }
    });
    for (const layer of ['clusters', 'city-points']) {
      map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', layer, () => {
        map.getCanvas().style.cursor = '';
        popup.remove();
      });
    }
    map.on('mousemove', 'city-points', (e) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== 'Point') return;
      popup
        .setLngLat(f.geometry.coordinates as [number, number])
        .setText(
          `${String(f.properties['label'])} · ${Number(f.properties['pop']).toLocaleString('fr-FR')} hab.`,
        )
        .addTo(map);
    });

    return () => {
      abort.abort();
      popup.remove();
      map.remove();
      mapRef.current = null;
      selectedRef.current = null;
    };
  }, [applyOwners, select, clearSelection, attempt]);

  const owner =
    selected?.ownerFactionId != null ? factionsRef.current.get(selected.ownerFactionId) : undefined;

  return (
    <div className="relative h-full w-full">
      <div className="absolute inset-0">
        <div ref={container} className="h-full w-full" />
      </div>

      <header className="pointer-events-none absolute left-4 top-4 flex flex-col gap-3">
        <div className="pointer-events-auto">
          <h1 className="text-2xl font-black tracking-[0.3em]">CONQUEST</h1>
          {counts && (
            <p className="text-xs text-slate-400">
              {counts.cities.toLocaleString('fr-FR')} villes · {counts.factions} nations
            </p>
          )}
        </div>
        {status === 'ready' && (
          <div className="pointer-events-auto">
            <SearchBox onPick={(id) => void select(id, true)} />
          </div>
        )}
      </header>

      <div className="absolute right-4 top-4 z-10">
        <AccountMenu onPlay={() => setForceOnboarding(true)} />
      </div>

      {authStatus === 'ready' && me && !me.user && (forceOnboarding || !onboardingDismissed) && (
        <OnboardingModal
          mode="guest"
          onClose={() => {
            setOnboardingDismissed(true);
            setForceOnboarding(false);
          }}
        />
      )}
      {authStatus === 'ready' && me?.user && !me.user.countryCode && (
        <OnboardingModal mode="country" />
      )}

      {status === 'loading' && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-slate-400">
          Chargement du monde…
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-x-0 top-1/3 mx-auto w-80 rounded-lg bg-red-950/90 p-4 text-center text-sm">
          <p className="mb-3">Impossible de charger les villes.</p>
          <p className="mb-3 text-xs text-red-300">{error}</p>
          <button
            className="rounded bg-red-600 px-3 py-1 font-semibold hover:bg-red-500"
            onClick={() => setAttempt((a) => a + 1)}
          >
            Réessayer
          </button>
        </div>
      )}

      {selected && <CityPanel city={selected} owner={owner} onClose={clearSelection} />}
    </div>
  );
}
