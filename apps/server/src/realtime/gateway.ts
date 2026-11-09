import type { FastifyInstance } from 'fastify';
import { parseCookie } from 'cookie';
import { Server, type Socket } from 'socket.io';
import {
  MAX_TILES_PER_SOCKET,
  isTileKey,
  type CityDelta,
  type ClientToServerEvents,
  type Faction,
  type GameEvent,
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
    if (!token) return next();
    resolveSession(db, token).then(
      (s) => {
        socket.data.userId = s?.userId ?? null;
        next();
      },
      () => next(), // base indisponible : on laisse regarder la carte en anonyme
    );
  });

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
    events
      .recent(20)
      .then((list) => socket.emit('feed:init', list))
      .catch(() => undefined);
    socket.emit('presence', { online: io.engine.clientsCount });

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

  const presence = setInterval(
    () => io.emit('presence', { online: io.engine.clientsCount }),
    deps.presenceIntervalMs ?? 5_000,
  );
  presence.unref();

  return {
    io,
    online: () => io.engine.clientsCount,
    delta: (tile: string, d: CityDelta) => void io.to(room(tile)).emit('delta', d),
    event: (e: GameEvent) => void io.to('feed').emit('event', e),
    close: async () => {
      clearInterval(presence);
      await io.close();
    },
  };
}
