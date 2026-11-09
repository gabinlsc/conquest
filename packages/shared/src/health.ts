/** Contrat de la route GET /api/health, partagé entre serveur, web et healthchecks. */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  version: string;
}
