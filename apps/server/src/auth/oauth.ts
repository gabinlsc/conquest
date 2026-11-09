import { createHash, randomBytes } from 'node:crypto';
import type { OAuthProvider, ServerEnv } from '@conquest/shared';
import type { OAuthProfile } from './users';

export type FetchLike = typeof fetch;

interface ProviderConfig {
  authUrl: string;
  tokenUrl: string;
  userUrl: string;
  scope: string;
  clientId: string;
  clientSecret: string;
  mapProfile: (raw: Record<string, unknown>) => Omit<OAuthProfile, 'provider'> | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Providers réellement configurés (variables d'env présentes) ; les autres sont désactivés. */
export function getProviders(env: ServerEnv): Partial<Record<OAuthProvider, ProviderConfig>> {
  const out: Partial<Record<OAuthProvider, ProviderConfig>> = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    out.google = {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      scope: 'openid profile',
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      mapProfile: (raw) => {
        const id = str(raw['sub']);
        return id
          ? {
              providerUserId: id,
              displayName: str(raw['given_name']) ?? str(raw['name']) ?? 'Joueur',
              avatarUrl: str(raw['picture']),
            }
          : null;
      },
    };
  }
  if (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
    out.discord = {
      authUrl: 'https://discord.com/oauth2/authorize',
      tokenUrl: 'https://discord.com/api/oauth2/token',
      userUrl: 'https://discord.com/api/users/@me',
      scope: 'identify',
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
      mapProfile: (raw) => {
        const id = str(raw['id']);
        const avatar = str(raw['avatar']);
        return id
          ? {
              providerUserId: id,
              displayName: str(raw['global_name']) ?? str(raw['username']) ?? 'Joueur',
              avatarUrl: avatar ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png` : null,
            }
          : null;
      },
    };
  }
  return out;
}

/** Données du flow OAuth gardées dans un cookie signé et éphémère entre /start et /callback. */
export interface OAuthTransaction {
  provider: OAuthProvider;
  state: string;
  verifier: string;
}

export function newTransaction(provider: OAuthProvider): OAuthTransaction {
  return {
    provider,
    state: randomBytes(16).toString('base64url'),
    // PKCE (RFC 7636) : même avec un secret client, protège contre l'interception du code.
    verifier: randomBytes(32).toString('base64url'),
  };
}

export const redirectUri = (publicUrl: string, provider: OAuthProvider) =>
  `${publicUrl.replace(/\/$/, '')}/api/auth/oauth/${provider}/callback`;

export function buildAuthorizeUrl(
  cfg: ProviderConfig,
  tx: OAuthTransaction,
  publicUrl: string,
): string {
  const url = new URL(cfg.authUrl);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(publicUrl, tx.provider),
    response_type: 'code',
    scope: cfg.scope,
    state: tx.state,
    code_challenge: createHash('sha256').update(tx.verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

/** Échange le code contre un profil. Toute erreur réseau/format remonte en Error : le callback redirige avec auth_error. */
export async function fetchProfile(
  cfg: ProviderConfig,
  tx: OAuthTransaction,
  code: string,
  publicUrl: string,
  fetchImpl: FetchLike,
): Promise<Omit<OAuthProfile, 'provider'>> {
  const tokenRes = await fetchImpl(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(publicUrl, tx.provider),
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code_verifier: tx.verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenRes.ok) throw new Error(`échange du code refusé (${tokenRes.status})`);
  const token = (await tokenRes.json()) as { access_token?: unknown };
  const accessToken = str(token.access_token);
  if (!accessToken) throw new Error('access_token absent');

  const userRes = await fetchImpl(cfg.userUrl, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!userRes.ok) throw new Error(`profil indisponible (${userRes.status})`);
  const profile = cfg.mapProfile((await userRes.json()) as Record<string, unknown>);
  if (!profile) throw new Error('profil illisible');
  return profile;
}
