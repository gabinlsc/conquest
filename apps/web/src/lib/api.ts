import type { FeatureCollection, Point } from 'geojson';
import type {
  AttackResult,
  AttackStartResponse,
  City,
  CityListResponse,
  ClanDetail,
  ClanSummary,
  Country,
  GameEvent,
  LeaderboardKind,
  LeaderboardResponse,
  MyRanks,
  PastSeason,
  SeasonInfo,
  MeResponse,
} from '@conquest/shared';

/** Relatif par défaut : Caddy (prod) ou le rewrite Next (dev) route /api vers le serveur. */
const API = process.env.NEXT_PUBLIC_API_URL ?? '/api';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    signal,
    credentials: 'same-origin', // cookie de session httpOnly
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    throw new ApiError(res.status, err?.error ?? `${path} → HTTP ${res.status}`, err?.code);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

const getJson = <T>(path: string, signal?: AbortSignal) =>
  request<T>('GET', path, undefined, signal);

export const fetchCitiesGeoJson = (signal?: AbortSignal) =>
  getJson<FeatureCollection<Point>>('/cities/geojson', signal);

export const fetchCity = (id: number, signal?: AbortSignal) =>
  getJson<City>(`/cities/${id}`, signal);

export const searchCities = (q: string, signal?: AbortSignal) =>
  getJson<CityListResponse>(`/cities?q=${encodeURIComponent(q)}&limit=8`, signal);

// ---------- Auth & clans ----------

export const fetchMe = (signal?: AbortSignal) => getJson<MeResponse>('/me', signal);
export const fetchCountries = () => getJson<Country[]>('/countries');
export const createGuest = (countryCode: string, displayName?: string) =>
  request<MeResponse>('POST', '/auth/guest', { countryCode, displayName });
export const patchMe = (patch: { displayName?: string; countryCode?: string }) =>
  request<MeResponse>('PATCH', '/me', patch);
export const logout = () => request<void>('POST', '/auth/logout');

export const listClans = (q: string, signal?: AbortSignal) =>
  getJson<{ items: ClanSummary[]; total: number }>(
    `/clans?limit=20${q ? `&q=${encodeURIComponent(q)}` : ''}`,
    signal,
  );
export const fetchClan = (id: number) => getJson<ClanDetail>(`/clans/${id}`);
export const createClan = (input: { name: string; color?: string; open: boolean }) =>
  request<{ id: number }>('POST', '/clans', input);
export const joinClan = (id: number, inviteCode?: string) =>
  request<void>('POST', `/clans/${id}/join`, inviteCode ? { inviteCode } : {});
export const leaveClan = () => request<{ disbanded: boolean }>('POST', '/clans/leave');

// ---------- Attaques ----------

export const startAttack = (cityId: number) =>
  request<AttackStartResponse>('POST', '/attacks', { cityId });

/** Envoie la preuve brute (actions du joueur), jamais un score. Idempotent côté serveur : on peut réessayer. */
export const submitAttack = (attackId: string, input: unknown) =>
  request<AttackResult>('POST', `/attacks/${attackId}/submit`, { input });

export const fetchRecentEvents = (signal?: AbortSignal) =>
  getJson<GameEvent[]>('/events?limit=20', signal);

// ---------- Saisons & classements ----------

export const fetchSeason = () => getJson<SeasonInfo>('/season');
export const fetchPastSeasons = () => getJson<PastSeason[]>('/seasons');
export const fetchLeaderboard = (kind: LeaderboardKind, country?: string, signal?: AbortSignal) =>
  getJson<LeaderboardResponse>(
    `/leaderboards/${kind}?limit=50${country ? `&country=${encodeURIComponent(country)}` : ''}`,
    signal,
  );
export const fetchMyRanks = (signal?: AbortSignal) => getJson<MyRanks>('/leaderboards/me', signal);
