#!/usr/bin/env node
/**
 * Test de charge de bout en bout : N joueurs connectés en temps réel, dont une partie joue de vraies
 * parties (création de compte -> démarrage -> 30 s de jeu -> preuve -> capture -> diffusion).
 *
 *   node scripts/loadtest.mjs --base http://localhost:3001 --players 1000 --attackers 300
 *
 * Aucune dépendance en plus : fetch (Node 22) + socket.io-client (déjà présent). Les joueurs sont
 * « humains » côté serveur (réactions 300-420 ms) : le but est de mesurer la capacité, pas de tricher.
 */
import { fork } from 'node:child_process';
import { io } from 'socket.io-client';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const BASE = arg('base', 'http://localhost:3001');

// ---------- Mode sonde (processus enfant) ----------
// La latence de diffusion est mesurée par un PROCESSUS À PART, avec quelques sockets seulement : le processus
// principal, qui absorbe les messages de 1 000 sockets, serait lui-même saturé et fausserait la mesure.
if (process.argv.includes('--probe-child')) {
  const tiles = arg('tiles', '').split(',').filter(Boolean);
  const latencies = [];
  const timeline = [];
  const sockets = Array.from({ length: 20 }, () => {
    const s = io(BASE, { path: '/ws', transports: ['websocket'], reconnection: false });
    s.on('connect', () => s.emit('sub', tiles));
    s.on('delta', (d) => {
      latencies.push(Date.now() - d.at);
      timeline.push([Date.now(), Date.now() - d.at]);
    });
    return s;
  });
  process.on('message', (m) => {
    if (m === 'stop') {
      process.send?.({ latencies, timeline });
      sockets.forEach((x) => x.close());
      setTimeout(() => process.exit(0), 100);
    }
  });
  process.send?.('ready');
  await new Promise(() => {}); // vit jusqu'au message 'stop'
}
const PLAYERS = Number(arg('players', 1000));
const ATTACKERS = Math.min(PLAYERS, Number(arg('attackers', 300)));
const CONCURRENCY = Number(arg('concurrency', 60));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) =>
  arr.length
    ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))]
    : NaN;
const fmt = (arr) =>
  `p50 ${pct(arr, 50).toFixed(0)} ms · p95 ${pct(arr, 95).toFixed(0)} ms · max ${Math.max(...arr).toFixed(0)} ms (n=${arr.length})`;

const TILE = 22.5;
const tileOf = (lon, lat) =>
  `${Math.min(15, Math.max(0, Math.floor((lon + 180) / TILE)))}:${Math.min(7, Math.max(0, Math.floor((lat + 90) / TILE)))}`;

/** Exécute `fn` sur chaque élément avec au plus `limit` appels simultanés. */
async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

const errors = {};
const bump = (k) => (errors[k] = (errors[k] ?? 0) + 1);
const timed = async (bucket, fn) => {
  const t = performance.now();
  try {
    return await fn();
  } finally {
    bucket.push(performance.now() - t);
  }
};

async function api(method, path, { cookie, ip, body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
      ...(cookie ? { cookie: `conquest_sid=${cookie}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') };
}

const t0 = Date.now();
console.log(`→ ${PLAYERS} joueurs, ${ATTACKERS} qui jouent une partie, cible ${BASE}`);

// Villes cibles : les plus peuplées (elles concentrent les abonnements comme dans une vraie partie).
const top = (await (await fetch(`${BASE}/api/cities?limit=200`)).json()).items;
const countries = (await (await fetch(`${BASE}/api/countries`)).json())
  .map((c) => c.code)
  .slice(0, 40);
const targetTiles = [...new Set(top.map((c) => tileOf(c.lon, c.lat)))];

// Sonde de latence dans un processus séparé, abonnée aux zones les plus actives.
const probe = fork(new URL(import.meta.url).pathname, [
  '--probe-child',
  '--base',
  BASE,
  '--tiles',
  targetTiles.slice(0, 6).join(','),
]);
await new Promise((resolve) => probe.once('message', resolve));

const players = Array.from({ length: PLAYERS }, (_, i) => ({
  i,
  ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${(i & 255) + 1}`,
  country: countries[i % countries.length],
  cookie: '',
  socket: null,
}));

// ---------- 1. création des comptes ----------
const tGuest = [];
await pool(players, CONCURRENCY, async (p) => {
  const r = await timed(tGuest, () =>
    api('POST', '/auth/guest', { ip: p.ip, body: { countryCode: p.country } }),
  );
  if (r.status !== 201) return bump(`guest:${r.status}`);
  p.cookie = /conquest_sid=([^;]+)/.exec(r.setCookie ?? '')?.[1] ?? '';
});
console.log(`comptes   : ${fmt(tGuest)}`);

// ---------- 2. connexions temps réel + abonnements ----------
const tConnect = [],
  tSnap = [];
let deltas = 0,
  events = 0,
  snapshots = 0;
await pool(
  players.filter((p) => p.cookie),
  CONCURRENCY,
  async (p) => {
    const tiles = [
      targetTiles[p.i % targetTiles.length],
      targetTiles[(p.i * 7 + 3) % targetTiles.length],
    ];
    const started = performance.now();
    const s = io(BASE, {
      path: '/ws',
      transports: ['websocket'],
      extraHeaders: { cookie: `conquest_sid=${p.cookie}` },
      reconnection: false,
    });
    p.socket = s;
    s.on('delta', () => {
      deltas++;
    });
    s.on('events', (list) => (events += list.length));
    let snapAt = 0;
    s.on('tiles', () => {
      snapshots++;
      if (!snapAt) {
        snapAt = performance.now();
        tSnap.push(snapAt - started);
      }
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 15000);
        s.once('connect', () => {
          clearTimeout(timer);
          tConnect.push(performance.now() - started);
          s.emit('sub', tiles);
          resolve();
        });
        s.once('connect_error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
    } catch (e) {
      bump(`socket:${e.message}`);
    }
  },
);
console.log(`connexion : ${fmt(tConnect)}`);
console.log(`instantané: ${fmt(tSnap)} (1er instantané après connexion)`);
await sleep(1500);
console.log(`en ligne  : ${players.filter((p) => p.socket?.connected).length} sockets connectées`);

// ---------- 3. parties jouées ----------
const humanInput = (targets) => ({
  clicks: targets.map((t, i) => ({
    t: t.appearAt + 300 + ((i * 37) % 120),
    x: t.x + t.radius * 0.2 * (((i * 13) % 7) / 7 - 0.5),
    y: t.y,
  })),
});
const tStart = [],
  tSubmit = [];
const results = { validated: 0, invalid: 0, captured: 0, defended: 0, noEffect: 0 };
const attackers = players.filter((p) => p.cookie).slice(0, ATTACKERS);
const gameStart = performance.now();
await Promise.all(
  attackers.map(async (p, n) => {
    await sleep((n / attackers.length) * 4000); // étale les départs sur 4 s (arrivées réalistes)
    const city = top[(p.i * 13) % top.length];
    const start = await timed(tStart, () =>
      api('POST', '/attacks', {
        cookie: p.cookie,
        ip: p.ip,
        body: { cityId: city.id, minigame: 'reflex' },
      }),
    );
    if (start.status !== 201) return bump(`start:${start.status}`);
    const { attackId, params } = start.data;
    const startedAt = performance.now();
    await sleep(Math.max(0, 30500 - (performance.now() - startedAt))); // temps réel : le serveur refuse une soumission trop précoce
    const sub = await timed(tSubmit, () =>
      api('POST', `/attacks/${attackId}/submit`, {
        cookie: p.cookie,
        ip: p.ip,
        body: { input: humanInput(params.targets) },
      }),
    );
    if (sub.status !== 200) return bump(`submit:${sub.status}`);
    if (sub.data.validated) results.validated++;
    else results.invalid++;
    const fx = sub.data.effect;
    if (!fx) results.noEffect++;
    else if (fx.captured) results.captured++;
    else if (fx.defended) results.defended++;
  }),
);
await sleep(1500);

// ---------- rapport ----------
console.log(`démarrage : ${fmt(tStart)}`);
console.log(`soumission: ${fmt(tSubmit)} (validation + effet Redis + diffusion)`);
console.log(
  `parties   : ${JSON.stringify(results)} en ${((performance.now() - gameStart) / 1000).toFixed(1)} s`,
);
console.log(
  `diffusion : ${deltas} deltas reçus (${(deltas / Math.max(1, players.length)).toFixed(1)}/client), ${events} événements, ${snapshots} instantanés`,
);
const probeResult = await new Promise((resolve) => {
  probe.once('message', resolve);
  probe.send('stop');
  setTimeout(() => resolve({ latencies: [] }), 5000);
});
if (process.argv.includes('--timeline') && probeResult.timeline?.length) {
  const t0 = probeResult.timeline[0][0];
  const buckets = {};
  for (const [t, l] of probeResult.timeline) (buckets[Math.floor((t - t0) / 1000)] ??= []).push(l);
  for (const [sec, ls] of Object.entries(buckets))
    console.log(
      `  t+${sec}s : ${ls.length} deltas, médiane ${pct(ls, 50)} ms, max ${Math.max(...ls)} ms`,
    );
}
if (probeResult.latencies.length) {
  console.log(
    `latence delta (serveur -> client, 20 sondes isolées) : ${fmt(probeResult.latencies)}`,
  );
}
console.log(`erreurs   : ${Object.keys(errors).length ? JSON.stringify(errors) : 'aucune'}`);
console.log(`durée     : ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const p of players) p.socket?.close();
process.exit(Object.keys(errors).length ? 1 : 0);
