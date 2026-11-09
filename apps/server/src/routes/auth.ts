import type { FastifyInstance } from 'fastify';
import {
  OAUTH_PROVIDERS,
  guessCountryFromAcceptLanguage,
  guestSchema,
  patchMeSchema,
  type MeResponse,
  type OAuthProvider,
  type ServerEnv,
} from '@conquest/shared';
import type { Db } from '../db/pool';
import { AppError } from '../http-error';
import { SESSION_COOKIE, createSession, destroySession } from '../auth/session';
import { createGuest, getMe, loginWithOAuth, updateProfile } from '../auth/users';
import {
  buildAuthorizeUrl,
  fetchProfile,
  getProviders,
  newTransaction,
  type FetchLike,
  type OAuthTransaction,
} from '../auth/oauth';
import { requireUser, setSessionCookie } from '../plugins/session';

export interface AuthDeps {
  db: Db;
  env: ServerEnv;
  fetchImpl: FetchLike;
}

const TX_COOKIE = 'conquest_oauth';
const isProvider = (v: string): v is OAuthProvider =>
  (OAUTH_PROVIDERS as readonly string[]).includes(v);

export function registerAuthRoutes(api: FastifyInstance, { db, env, fetchImpl }: AuthDeps): void {
  const providers = getProviders(env);
  const configured = OAUTH_PROVIDERS.filter((p) => providers[p]);
  const home = env.PUBLIC_URL.replace(/\/$/, '') + '/';

  const meResponse = async (
    userId: string | null,
    acceptLanguage?: string,
  ): Promise<MeResponse> => {
    const base = userId ? await getMe(db, userId) : { user: null, faction: null };
    return {
      ...base,
      countryHint: guessCountryFromAcceptLanguage(acceptLanguage),
      providers: configured,
    };
  };

  api.get('/me', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return meResponse(req.userId, req.headers['accept-language']);
  });

  api.patch('/me', async (req) => {
    const userId = requireUser(req);
    await updateProfile(db, userId, patchMeSchema.parse(req.body));
    return meResponse(userId, req.headers['accept-language']);
  });

  // Limites par IP (en mémoire ; passage à un store Redis partagé en phase 5).
  api.post(
    '/auth/guest',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      // Déjà connecté : on ne crée pas de second compte, on renvoie l'existant.
      if (req.userId) return meResponse(req.userId, req.headers['accept-language']);
      const body = guestSchema.parse(req.body);
      const userId = await createGuest(db, body);
      const { token, expiresAt } = await createSession(db, userId);
      setSessionCookie(reply, env, token, expiresAt);
      return reply.code(201).send(await meResponse(userId, req.headers['accept-language']));
    },
  );

  api.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await destroySession(db, token);
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  // ---------- OAuth (Authorization Code + PKCE) ----------

  api.get<{ Params: { provider: string } }>(
    '/auth/oauth/:provider/start',
    { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const { provider } = req.params;
      const cfg = isProvider(provider) ? providers[provider] : undefined;
      if (!isProvider(provider) || !cfg) throw new AppError(404, 'fournisseur non configuré');
      const tx = newTransaction(provider);
      void reply.setCookie(TX_COOKIE, JSON.stringify(tx), {
        httpOnly: true,
        sameSite: 'lax', // doit être envoyé au retour (navigation top-level GET depuis le provider)
        secure: env.PUBLIC_URL.startsWith('https:'),
        path: '/api/auth/oauth',
        signed: true,
        maxAge: 600,
      });
      return reply.redirect(buildAuthorizeUrl(cfg, tx, env.PUBLIC_URL));
    },
  );

  api.get<{
    Params: { provider: string };
    Querystring: { code?: string; state?: string; error?: string };
  }>('/auth/oauth/:provider/callback', async (req, reply) => {
    const fail = (reason: string) =>
      reply.redirect(`${home}?auth_error=${encodeURIComponent(reason)}`);
    void reply.clearCookie(TX_COOKIE, { path: '/api/auth/oauth' });

    const { provider } = req.params;
    const cfg = isProvider(provider) ? providers[provider] : undefined;
    if (!isProvider(provider) || !cfg) return fail('provider');
    if (req.query.error || !req.query.code || !req.query.state) return fail('refused');

    // Le cookie est signé : on vérifie la signature PUIS que `state` correspond (anti-CSRF du flow OAuth).
    const raw = req.cookies[TX_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    if (!unsigned?.valid || !unsigned.value) return fail('expired');
    let tx: OAuthTransaction;
    try {
      tx = JSON.parse(unsigned.value) as OAuthTransaction;
    } catch {
      return fail('expired');
    }
    if (tx.provider !== provider || tx.state !== req.query.state) return fail('state');

    try {
      const profile = await fetchProfile(cfg, tx, req.query.code, env.PUBLIC_URL, fetchImpl);
      // Invité actuel : on lie l'identité à ce compte pour conserver sa progression.
      let guestId: string | null = null;
      if (req.userId) {
        const me = await getMe(db, req.userId);
        if (me.user?.kind === 'guest') guestId = req.userId;
      }
      const userId = await loginWithOAuth(
        db,
        { provider, ...profile },
        guestId,
        guessCountryFromAcceptLanguage(req.headers['accept-language']),
      );
      // Nouvelle session à chaque login (anti session-fixation) ; l'ancienne est révoquée.
      const old = req.cookies[SESSION_COOKIE];
      if (old) await destroySession(db, old);
      const { token, expiresAt } = await createSession(db, userId);
      setSessionCookie(reply, env, token, expiresAt);
      return reply.redirect(home);
    } catch (err) {
      req.log.warn({ err, provider }, 'échec du login OAuth');
      return fail('failed');
    }
  });
}
