import type { FeatureCollection, Point } from 'geojson';
import type { City, CityListResponse, WorldState } from '@conquest/shared';

/** Relatif par défaut : Caddy (prod) ou le rewrite Next (dev) route /api vers le serveur. */
const API = process.env.NEXT_PUBLIC_API_URL ?? '/api';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API}${path}`, { signal });
  if (!res.ok) throw new ApiError(res.status, `${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const fetchCitiesGeoJson = (signal?: AbortSignal) =>
  getJson<FeatureCollection<Point>>('/cities/geojson', signal);

export const fetchWorldState = (signal?: AbortSignal) =>
  getJson<WorldState>('/world/state', signal);

export const fetchCity = (id: number, signal?: AbortSignal) =>
  getJson<City>(`/cities/${id}`, signal);

export const searchCities = (q: string, signal?: AbortSignal) =>
  getJson<CityListResponse>(`/cities?q=${encodeURIComponent(q)}&limit=8`, signal);
