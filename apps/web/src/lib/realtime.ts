import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@conquest/shared';

export type RealtimeSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
export type ConnectionStatus = 'connecting' | 'online' | 'offline';

/**
 * Adresse du serveur temps réel. En production, même origine (Caddy route /ws vers le serveur).
 * En développement, le front (:3000) parle directement au serveur (:3001) : les rewrites de Next
 * ne relaient pas de façon fiable les WebSockets.
 */
export function realtimeUrl(): string {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  if (configured && configured.startsWith('http')) return configured;
  if (window.location.port === '3000') {
    return `${window.location.protocol}//${window.location.hostname}:3001`;
  }
  return window.location.origin;
}

/**
 * Crée la connexion. La reconnexion automatique (attente croissante 1 s -> 5 s, avec aléa pour éviter
 * que tous les clients reviennent en même temps après une panne) est gérée par Socket.IO ; à chaque
 * reconnexion le composant ré-envoie ses abonnements et reçoit de nouveaux instantanés.
 */
export function createRealtime(): RealtimeSocket {
  return io(realtimeUrl(), {
    path: '/ws',
    withCredentials: true, // cookie de session
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 5_000,
    randomizationFactor: 0.5,
  });
}
