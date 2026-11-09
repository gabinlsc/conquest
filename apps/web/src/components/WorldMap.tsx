'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import * as maplibregl from 'maplibre-gl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trophy } from 'lucide-react';
import {
  tilesForBounds,
  type City,
  type CityAlert,
  type Faction,
  type GameEvent,
  type SeasonInfo,
} from '@conquest/shared';
import { fetchCitiesGeoJson, fetchCity, fetchSeason } from '@/lib/api';
import { createRealtime, type ConnectionStatus, type RealtimeSocket } from '@/lib/realtime';
import { NEUTRAL_COLOR, baseStyle, radiusExpression } from '@/lib/mapStyle';
import { CityPanel } from './CityPanel';
import { LeaderboardPanel, countdown } from './LeaderboardPanel';
import { LiveFeed } from './LiveFeed';
import { SoundToggle } from './SoundToggle';
import { Toasts } from './Toasts';
import { sfx, unlockAudio } from '@/lib/sound';
import { SearchBox } from './SearchBox';
import { AccountMenu } from './AccountMenu';
import { AttackOverlay } from './AttackOverlay';
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
  const [counts, setCounts] = useState<{ cities: number } | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [online, setOnline] = useState(0);
  const [conn, setConn] = useState<ConnectionStatus>('connecting');
  const [now, setNow] = useState(() => Date.now());
  // Dernière version connue de chaque ville : les messages plus anciens (instantané tardif, delta en retard) sont ignorés.
  const knownRef = useRef<Map<number, { owner: number; ver: number }>>(new Map());
  const [selected, setSelected] = useState<City | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { me, status: authStatus } = useAuth();
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [forceOnboarding, setForceOnboarding] = useState(false);
  const [attacking, setAttacking] = useState<City | null>(null);
  const [showBoard, setShowBoard] = useState(false);
  const [season, setSeason] = useState<SeasonInfo | null>(null);
  const [alerts, setAlerts] = useState<CityAlert[]>([]);
  const rtRef = useRef<RealtimeSocket | null>(null);
  const myFactionRef = useRef<number | null>(null);
  const lastUserRef = useRef<string | null | undefined>(undefined);
  const [seasonBanner, setSeasonBanner] = useState<string | null>(null);

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

  /** Recharge le détail de la ville ouverte (influence à jour) sans toucher à la sélection. */
  const refreshSelected = useCallback((id: number) => {
    fetchCity(id).then(
      (city) => {
        if (selectedRef.current === id) setSelected(city);
      },
      () => undefined,
    );
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

    // ---- Temps réel : abonnements par tuile (zone visible) + flux d'événements ----
    const rt: RealtimeSocket = createRealtime();
    rtRef.current = rt;

    // ---- Vagues de capture : anneaux concentriques animés autour de la ville (source GeoJSON dédiée,
    // une seule mise à jour de données par image ; aucun élément DOM). Désactivées si « moins d'animations ». ----
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    interface Wave {
      lon: number;
      lat: number;
      color: string;
      t0: number;
      max: number;
    }
    const waves: Wave[] = [];
    let waveRaf = 0;
    const WAVE_MS = 1_500;
    const stepWaves = (now: number) => {
      const alive = waves.filter((w) => now - w.t0 < WAVE_MS);
      waves.length = 0;
      waves.push(...alive);
      const src = map.getSource<maplibregl.GeoJSONSource>('waves');
      void src?.setData({
        type: 'FeatureCollection',
        features: alive
          .filter((w) => now >= w.t0)
          .map((w) => {
            const p = (now - w.t0) / WAVE_MS;
            const ease = 1 - (1 - p) ** 3;
            return {
              type: 'Feature' as const,
              properties: { r: 6 + ease * w.max, o: 1 - p, w: 6 * (1 - p) + 1, c: w.color },
              geometry: { type: 'Point' as const, coordinates: [w.lon, w.lat] },
            };
          }),
      });
      waveRaf = alive.length > 0 ? requestAnimationFrame(stepWaves) : 0;
    };
    const spawnWave = (lon: number, lat: number, color: string, big: boolean) => {
      if (reduceMotion || !map.getBounds().contains([lon, lat])) return;
      const t = performance.now();
      const rings = big ? 3 : 1;
      for (let i = 0; i < rings; i++)
        waves.push({ lon, lat, color, t0: t + i * 220, max: big ? 150 : 60 });
      if (!waveRaf) waveRaf = requestAnimationFrame(stepWaves);
    };
    let sourceReady = false;
    let tilesKey = '';

    const paint = (id: number, owner: number) => {
      const color = owner ? factionsRef.current.get(owner)?.color : undefined;
      // `null` : aucune couleur -> retombe sur la couleur neutre de l'expression coalesce.
      map.setFeatureState({ source: SRC, id }, { color: color ?? null });
    };
    const applyEntry = (id: number, owner: number, ver: number) => {
      const known = knownRef.current.get(id);
      // Un instantané de secours (ver 0, venu de Postgres) ne remplace jamais une version réelle.
      const fresher = !known || ver > known.ver || (ver === 0 && known.ver === 0);
      if (!fresher) return;
      knownRef.current.set(id, { owner, ver });
      paint(id, owner);
    };
    const syncTiles = (force = false) => {
      if (!sourceReady) return;
      let tiles: string[] = [];
      // Zoom monde : les points sont regroupés en clusters, aucune couleur individuelle à afficher.
      if (map.getZoom() >= 5.5) {
        const b = map.getBounds();
        tiles = tilesForBounds(b.getWest(), b.getSouth(), b.getEast(), b.getNorth());
      }
      const key = tiles.join(',');
      if (!force && key === tilesKey) return;
      tilesKey = key;
      rt.emit('sub', tiles);
    };

    rt.on('connect', () => {
      setConn('online');
      syncTiles(true); // le serveur a perdu nos abonnements pendant la coupure : on les redemande
    });
    rt.on('disconnect', () => setConn('offline'));
    rt.on('connect_error', () => setConn('offline'));
    rt.on('tiles', (snap) => {
      for (const f of snap.factions) factionsRef.current.set(f.id, f);
      for (const [id, owner, ver] of snap.cities) applyEntry(id, owner, ver);
    });
    rt.on('delta', (d) => {
      if (d.faction) factionsRef.current.set(d.faction.id, d.faction);
      const previous = knownRef.current.get(d.id);
      applyEntry(d.id, d.owner, d.ver);
      if (previous && d.ver > previous.ver) {
        const changedHands = previous.owner !== d.owner;
        const color = (changedHands && d.faction?.color) || '#111111';
        spawnWave(d.lon, d.lat, color, changedHands);
        if (changedHands && map.getBounds().contains([d.lon, d.lat])) {
          // Ma faction vient de prendre une ville visible : petite fanfare ; sinon un bruit de vague discret.
          if (d.owner === myFactionRef.current) sfx.capture();
          else sfx.wave();
        }
      }
      if (selectedRef.current === d.id) refreshSelected(d.id);
    });
    rt.on('alert', (a) => {
      setAlerts((prev) => [a, ...prev.filter((x) => x.id !== a.id)].slice(0, 5));
      sfx.alert();
      // Onglet en arrière-plan : notification native du navigateur (si le joueur l'a autorisée).
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        new Notification(
          a.captured ? `${a.cityName} est tombée !` : `${a.cityName} est attaquée !`,
          {
            body: `${a.by.name}${a.captured ? ' a capturé la ville.' : ` attaque (+${a.gain}).`}`,
            tag: `conquest-${a.cityId}`,
          },
        );
      }
    });
    rt.on('events', (list) =>
      setEvents((prev) => {
        const ids = new Set(list.map((x) => x.id));
        return [...[...list].reverse(), ...prev.filter((x) => !ids.has(x.id))].slice(0, 20);
      }),
    );
    rt.on('feed:init', (list) => setEvents(list));
    rt.on('presence', (p) => setOnline(p.online));
    rt.on('season', ({ season: next, reset }) => {
      setSeason(next);
      if (!reset) return;
      // Nouvelle saison : la carte entière a été remise à zéro côté serveur. On efface tout ce qu'on savait,
      // on se désabonne puis on se réabonne (le serveur renvoie alors des instantanés tout neufs).
      knownRef.current.clear();
      map.removeFeatureState({ source: SRC });
      setEvents([]);
      setSeasonBanner(`${next.name} commence ! La carte repart de zéro.`);
      setTimeout(() => setSeasonBanner(null), 8_000);
      rt.emit('sub', []);
      syncTiles(true);
      if (selectedRef.current !== null) refreshSelected(selectedRef.current);
    });

    fetchSeason().then(setSeason, () => undefined);

    let moveTimer: ReturnType<typeof setTimeout> | undefined;
    map.on('moveend', () => {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => syncTiles(), 150);
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });

    map.on('load', () => {
      fetchCitiesGeoJson(abort.signal)
        .then((geojson) => {
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
                '#c3a6ff',
                50,
                '#ffd84d',
                300,
                '#ff9478',
              ],
              'circle-opacity': 1,
              'circle-radius': ['step', ['get', 'point_count'], 13, 20, 17, 100, 22, 400, 28],
              'circle-stroke-color': '#111111',
              'circle-stroke-opacity': 1,
              'circle-stroke-width': 2.5,
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
            paint: { 'text-color': '#111111' },
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
              'circle-stroke-color': '#111111',
              'circle-stroke-width': [
                'case',
                ['boolean', ['feature-state', 'selected'], false],
                3.5,
                1.4,
              ],
              'circle-stroke-opacity': 1,
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
              'text-color': '#111111',
              'text-halo-color': '#fffdf0',
              'text-halo-width': 1.6,
            },
          });

          map.addSource('waves', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          });
          map.addLayer({
            id: 'wave-fill',
            type: 'circle',
            source: 'waves',
            paint: {
              'circle-radius': ['get', 'r'],
              'circle-color': ['get', 'c'],
              'circle-opacity': ['*', ['get', 'o'], 0.22],
              'circle-pitch-alignment': 'map',
            },
          });
          map.addLayer({
            id: 'wave-ring',
            type: 'circle',
            source: 'waves',
            paint: {
              'circle-radius': ['get', 'r'],
              'circle-color': '#000000',
              'circle-opacity': 0,
              'circle-stroke-color': ['get', 'c'],
              'circle-stroke-width': ['get', 'w'],
              'circle-stroke-opacity': ['get', 'o'],
              'circle-pitch-alignment': 'map',
            },
          });

          setCounts({ cities: geojson.features.length });
          setStatus('ready');
          sourceReady = true;
          syncTiles(true);
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
      cancelAnimationFrame(waveRaf);
      rtRef.current = null;
      clearTimeout(moveTimer);
      rt.close();
      knownRef.current.clear();
      popup.remove();
      map.remove();
      mapRef.current = null;
      selectedRef.current = null;
    };
  }, [select, clearSelection, refreshSelected, attempt]);

  // Débloque l'audio au premier geste (les navigateurs interdisent le son avant toute interaction).
  useEffect(() => {
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    return () => window.removeEventListener('pointerdown', unlockAudio);
  }, []);

  // La connexion temps réel porte le cookie de session : quand le joueur change (invité créé, connexion, déconnexion),
  // on se reconnecte pour qu'elle soit authentifiée (nécessaire aux alertes) ; quand seule sa faction change
  // (clan rejoint/quitté, nouveau pays), un simple « faction:refresh » suffit.
  const userId = me?.user?.id ?? null;
  const factionId = me?.faction?.id ?? null;
  useEffect(() => {
    myFactionRef.current = factionId;
    if (authStatus !== 'ready') return;
    const rt = rtRef.current;
    if (lastUserRef.current === undefined) {
      lastUserRef.current = userId;
      return;
    }
    if (lastUserRef.current !== userId) {
      lastUserRef.current = userId;
      rt?.disconnect().connect();
    } else {
      rt?.emit('faction:refresh');
    }
  }, [authStatus, userId, factionId]);

  // Rafraîchit les « il y a X s » du flux.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const owner = selected?.ownerFaction ?? undefined;

  // Règles d'affichage du bouton ; le serveur re-vérifie TOUT (faction, cooldown, saison).
  const myFactionId = me?.faction?.id ?? null;
  const attackAction: React.ComponentProps<typeof CityPanel>['action'] = !selected
    ? { label: 'Attaquer', enabled: false, onClick: () => undefined, kind: 'other' }
    : !me?.user
      ? {
          label: 'Joue pour attaquer',
          enabled: true,
          onClick: () => setForceOnboarding(true),
          kind: 'other',
        }
      : myFactionId === null
        ? {
            label: 'Rejoins une faction pour attaquer',
            enabled: false,
            onClick: () => undefined,
            kind: 'other',
          }
        : selected.ownerFactionId === myFactionId
          ? {
              label: 'Défendre',
              enabled: true,
              onClick: () => setAttacking(selected),
              kind: 'defend',
            }
          : {
              label: 'Attaquer',
              enabled: true,
              onClick: () => setAttacking(selected),
              kind: 'attack',
            };

  return (
    <div className="relative h-full w-full">
      <div className="absolute inset-0">
        <div ref={container} className="h-full w-full" />
      </div>

      <header className="pointer-events-none absolute left-4 top-4 z-10 flex flex-col items-start gap-3">
        <div className="card pointer-events-auto -rotate-1 bg-banana px-4 py-2">
          <h1 className="text-3xl uppercase leading-none tracking-wide">
            Con<span className="hl">quest</span>
          </h1>
          {counts && (
            <p className="mt-0.5 text-xs font-bold">
              {counts.cities.toLocaleString('fr-FR')} villes à conquérir
            </p>
          )}
        </div>
        {season && (
          <button
            onClick={() => setShowBoard((v) => !v)}
            className="pill pointer-events-auto cursor-pointer bg-lilac hover:-translate-y-px"
            title="Voir les classements"
          >
            {season.name} · {countdown(season.endsAt, now)}
          </button>
        )}
        {status === 'ready' && (
          <div className="pointer-events-auto">
            <SearchBox onPick={(id) => void select(id, true)} />
          </div>
        )}
      </header>

      <div className="absolute right-4 top-4 z-20 flex items-start gap-2">
        <SoundToggle />
        <button
          onClick={() => setShowBoard((v) => !v)}
          className="btn btn-lilac"
          aria-label="Classements"
        >
          <Trophy className="h-4 w-4" strokeWidth={3} />
          <span className="hidden sm:inline">Classements</span>
        </button>
        <AccountMenu onPlay={() => setForceOnboarding(true)} />
      </div>

      {showBoard && <LeaderboardPanel now={now} onClose={() => setShowBoard(false)} />}

      {seasonBanner && (
        <div className="card absolute left-1/2 top-24 z-30 -translate-x-1/2 -rotate-1 bg-mint px-5 py-3 text-center font-display text-lg font-bold">
          🎉 {seasonBanner}
        </div>
      )}

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
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <p className="card bg-white px-5 py-3 font-display text-xl font-bold">
            Chargement du monde…
          </p>
        </div>
      )}
      {status === 'error' && (
        <div className="card absolute inset-x-0 top-1/3 z-20 mx-auto w-80 bg-coral p-4 text-center">
          <p className="font-display text-xl font-bold">Impossible de charger les villes.</p>
          <p className="my-2 text-xs font-medium">{error}</p>
          <button className="btn btn-banana" onClick={() => setAttempt((a) => a + 1)}>
            Réessayer
          </button>
        </div>
      )}

      {selected && (
        <CityPanel city={selected} owner={owner} onClose={clearSelection} action={attackAction} />
      )}
      <LiveFeed
        events={events}
        online={online}
        status={conn}
        now={now}
        onPick={(e: GameEvent) => void select(e.cityId, true)}
      />
      <Toasts
        alerts={alerts}
        onDismiss={(id) => setAlerts((prev) => prev.filter((a) => a.id !== id))}
        onView={(a) => {
          setAlerts((prev) => prev.filter((x) => x.id !== a.id));
          void select(a.cityId, true);
        }}
      />
      {attacking && <AttackOverlay city={attacking} onClose={() => setAttacking(null)} />}
    </div>
  );
}
