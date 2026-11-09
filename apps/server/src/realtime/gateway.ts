import type { FastifyInstance } from 'fastify';
import { parseCookie } from 'cookie';
import { Server, type Socket } from 'socket.io';
import {
  MAX_TILES_PER_SOCKET,
  isTileKey,
  type CityAlert,
  type CityDelta,
  type ClientToServerEvents,
  type Faction,
  type GameEvent,
  type SeasonInfo,
  type ServerEnv,
  type ServerToClientEvents,
  type TileSnapshot,
} from '@conquest/shared';
import type { Publisher } from '../attacks/effects';
import { SESSION_COOKIE, resolveSession } from '../auth/session';
import type { Db } from '../db/pool';
import type { EventService } from '../events/service';
import type { FactionDirectory } from '../world/factions';
import type { WorldStore } from '../world/store';

interface SocketData {
  userId: string | null;
  /** Faction du joueur connecté (room d'alertes `f:<id>`). */
  factionId: number | null;
  tiles: Set<string>;
  /** Jetons de rate limiting des messages `sub`. */
  tokens: number;
  refillAt: number;
}

type GameSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export interface Gateway extends Publisher {
  io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
  online(): number;
  close(): Promise<void>;
}

const SUB_BURST = 20;
const SUB_REFILL_MS = 1_000;
const room = (tile: string) => `t:${tile}`;

/**
 * Passerelle temps réel Socket.IO.
 *  - Abonnements PAR TUILE : un client ne reçoit que les villes de sa zone visible (règle n°4).
 *  - Diffusion en DELTAS : une ville à la fois, jamais l'état complet ; à l'abonnement, un instantané de la tuile.
 *  - Flux d'événements (captures) : room `feed`, volume faible et volontairement global.
 */
export function attachGateway(
  app: FastifyInstance,
  deps: {
    env: Pick<ServerEnv, 'PUBLIC_URL'>;
    db: Db;
    store: WorldStore;
    factions: FactionDirectory;
    events: EventService;
    presenceIntervalMs?: number;
  },
): Gateway {
  const { env, db, store, factions, events } = deps;
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(app.server, {
    path: '/ws',
    serveClient: false,
    // Les clients d'envoi sont minuscules (liste de tuiles) : on borne la taille pour couper court aux abus.
    maxHttpBufferSize: 4_096,
    // Même origine en production (Caddy) ; en dev le front (:3000) parle directement au serveur (:3001).
    cors: { origin: new URL(env.PUBLIC_URL).origin, credentials: true },
    perMessageDeflate: { threshold: 1_024 },
  });

  // Authentification par le cookie de session (httpOnly) envoyé lors de la poignée de main.
  // Les anonymes peuvent regarder la carte ; l'identité servira aux notifications personnelles.
  io.use((socket, next) => {
    const token = parseCookie(socket.handshake.headers.cookie ?? '')[SESSION_COOKIE];
    socket.data.tiles = new Set();
    socket.data.tokens = SUB_BURST;
    socket.data.refillAt = Date.now();
    socket.data.userId = null;
    socket.data.factionId = null;
    if (!token) return next();
    resolveSession(db, token).then(
      async (s) => {
        socket.data.userId = s?.userId ?? null;
        socket.data.factionId = s ? await factionOf(s.userId) : null;
        next();
      },
      () => next(), // base indisponible : on laisse regarder la carte en anonyme
    );
  });

  /** Faction courante d'un joueur (pays ou clan), null s'il n'en a pas. */
  async function factionOf(userId: string): Promise<number | null> {
    try {
      const { rows } = await db.query<{ faction_id: number }>(
        'SELECT faction_id FROM faction_members WHERE user_id = $1',
        [userId],
      );
      return rows[0]?.faction_id ?? null;
    } catch {
      return null;
    }
  }

  const takeToken = (socket: GameSocket): boolean => {
    const d = socket.data;
    const now = Date.now();
    d.tokens = Math.min(SUB_BURST, d.tokens + Math.floor((now - d.refillAt) / SUB_REFILL_MS));
    d.refillAt = now;
    if (d.tokens <= 0) return false;
    d.tokens--;
    return true;
  };

  async function snapshot(tile: string): Promise<TileSnapshot> {
    let cities: [number, number, number][];
    try {
      cities = store.isUp()
        ? await store.tileSnapshot(tile)
        : await store.tileSnapshotFromPg(db, tile);
    } catch {
      // Redis est tombé entre le test et la lecture : on sert la dernière copie persistée.
      cities = await store.tileSnapshotFromPg(db, tile);
    }
    const ids = new Set(cities.map((c) => c[1]).filter((o) => o !== 0));
    const found = await Promise.all([...ids].map((id) => factions.get(id)));
    return { tile, cities, factions: found.filter((f): f is Faction => f !== null) };
  }

  io.on('connection', (socket: GameSocket) => {
    void socket.join('feed');
    if (socket.data.factionId !== null) void socket.join(`f:${socket.data.factionId}`);
    events
      .recent(20)
      .then((list) => socket.emit('feed:init', list))
      .catch(() => undefined);
    socket.emit('presence', { online: io.engine.clientsCount });

    // Le joueur vient de changer de faction (clan, pays) : ses alertes suivent sa nouvelle faction.
    socket.on('faction:refresh', () => {
      const userId = socket.data.userId;
      if (!userId || !takeToken(socket)) return;
      void factionOf(userId).then((next) => {
        const prev = socket.data.factionId;
        if (prev === next) return;
        if (prev !== null) void socket.leave(`f:${prev}`);
        if (next !== null) void socket.join(`f:${next}`);
        socket.data.factionId = next;
      });
    });

    socket.on('sub', (raw, ack) => {
      if (!takeToken(socket)) return ack?.({ tiles: [...socket.data.tiles] });
      const wanted = new Set(
        (Array.isArray(raw) ? raw : [])
          .filter((t): t is string => typeof t === 'string' && isTileKey(t))
          .slice(0, MAX_TILES_PER_SOCKET),
      );
      const current = socket.data.tiles;
      for (const t of current) {
        if (!wanted.has(t)) {
          void socket.leave(room(t));
          current.delete(t);
        }
      }
      const added = [...wanted].filter((t) => !current.has(t));
      // On rejoint la room AVANT de lire l'instantané : un delta survenant entre les deux n'est pas perdu
      // (le client départage instantané et deltas grâce au numéro de version par ville).
      for (const t of added) {
        void socket.join(room(t));
        current.add(t);
      }
      ack?.({ tiles: [...current] });
      for (const t of added) {
        snapshot(t).then(
          (s) => socket.emit('tiles', s),
          () => undefined,
        );
      }
    });
  });

  // Flux d'événements : regroupés par lots de 200 ms. Chaque capture serait sinon un message par client connecté
  // (1 000 clients x 25 captures/s = 25 000 écritures/s en rafale) ; un lot coûte une seule écriture par client.
  let feedBatch: GameEvent[] = [];
  let feedTimer: ReturnType<typeof setTimeout> | null = null;
  const FEED_BATCH_MS = 200;
  const flushFeed = () => {
    feedTimer = null;
    if (feedBatch.length === 0) return;
    const batch = feedBatch;
    feedBatch = [];
    io.to('feed').emit('events', batch);
  };

  const presence = setInterval(
    () => io.emit('presence', { online: io.engine.clientsCount }),
    deps.presenceIntervalMs ?? 5_000,
  );
  presence.unref();

  return {
    io,
    online: () => io.engine.clientsCount,
    delta: (tile: string, d: CityDelta) => void io.to(room(tile)).emit('delta', d),
    event: (e: GameEvent) => {
      feedBatch.push(e);
      if (!feedTimer) {
        feedTimer = setTimeout(flushFeed, FEED_BATCH_MS);
        feedTimer.unref();
      }
    },
    season: (season: SeasonInfo, reset: boolean) => void io.emit('season', { season, reset }),
    alert: (factionId: number, alert: CityAlert) =>
      void io.to(`f:${factionId}`).emit('alert', alert),
    close: async () => {
      clearInterval(presence);
      if (feedTimer) clearTimeout(feedTimer);
      await io.close();
    },
  };
}
