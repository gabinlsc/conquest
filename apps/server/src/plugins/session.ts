import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import type { ServerEnv } from '@conquest/shared';
import type { Db } from '../db/pool';
import { AppError, unauthorized } from '../http-error';
import { SESSION_COOKIE, SESSION_TTL_DAYS, resolveSession } from '../auth/session';

declare module 'fastify' {
  interface FastifyRequest {
    /** Identifiant du joueur authentifié, ou null. */
    userId: string | null;
  }
}

export function sessionCookieOptions(env: Pick<ServerEnv, 'PUBLIC_URL'>, expires?: Date) {
  return {
    httpOnly: true, // illisible depuis JS : un XSS ne peut pas voler la session
    sameSite: 'lax' as const, // bloque l'envoi du cookie sur les POST cross-site (CSRF), autorise le retour OAuth
    secure: env.PUBLIC_URL.startsWith('https:'),
    path: '/',
    expires: expires ?? new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000),
  };
}

export function setSessionCookie(
  reply: FastifyReply,
  env: Pick<ServerEnv, 'PUBLIC_URL'>,
  token: string,
  expires: Date,
): void {
  void reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(env, expires));
}

export async function registerSession(
  app: FastifyInstance,
  env: Pick<ServerEnv, 'PUBLIC_URL' | 'SESSION_SECRET'>,
  db: Db,
): Promise<void> {
  // `secret` sert à signer les cookies éphémères du flow OAuth (state/PKCE).
  await app.register(cookie, { secret: env.SESSION_SECRET });
  app.decorateRequest('userId', null);

  const allowedOrigin = new URL(env.PUBLIC_URL).origin;

  // Défense CSRF en profondeur (en plus de SameSite=Lax) : une requête qui modifie l'état et dont
  // l'en-tête Origin est présent doit venir de notre propre site. Les clients sans Origin
  // (curl, tests, apps natives) ne sont pas concernés par le CSRF : le cookie ne part pas tout seul.
  app.addHook('onRequest', (req, _reply, done) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      const origin = req.headers.origin;
      if (origin && origin !== allowedOrigin) {
        done(new AppError(403, 'origine non autorisée', 'bad_origin'));
        return;
      }
    }
    done();
  });

  app.addHook('onRequest', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const session = await resolveSession(db, token);
    if (!session) {
      void reply.clearCookie(SESSION_COOKIE, { path: '/' }); // jeton expiré/révoqué
      return;
    }
    req.userId = session.userId;
    if (session.renewedUntil) setSessionCookie(reply, env, token, session.renewedUntil);
  });
}

export function requireUser(req: FastifyRequest): string {
  if (!req.userId) throw unauthorized();
  return req.userId;
}
