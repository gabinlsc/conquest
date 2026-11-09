/** Contrat de la route GET /api/health, partagé entre serveur, web et healthchecks. */
export interface HealthResponse {
  /** `degraded` : le serveur répond mais une dépendance est indisponible. */
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  version: string;
  services: { db: 'up' | 'down' };
}
