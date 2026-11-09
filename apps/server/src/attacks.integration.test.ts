import type { LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MEMORY,
  QUIZ,
  memoryGame,
  reflexGame,
  type MemoryParams,
  type QuizParams,
  type AttackResult,
  type AttackStartResponse,
  type ReflexInput,
  type ReflexParams,
} from '@conquest/shared';
import { buildApp } from './app';
import { __answerKey } from './minigames/quiz';
import { deriveSeed } from './attacks/service';
import { importGeonames } from './geonames/import';
import { FIXTURE_ADMIN1, FIXTURE_CITIES, FIXTURE_COUNTRIES } from './geonames/fixtures';
import { testEnv } from './test-helpers';

/** Intégration des attaques : démarrage, preuve, validation serveur, idempotence, anti-triche. */
const url = process.env['TEST_DATABASE_URL'];
const files = { cities: FIXTURE_CITIES, countries: FIXTURE_COUNTRIES, admin1: FIXTURE_ADMIN1 };
const BERLIN = 2950159;
const PARIS = 2988507;

describe.skipIf(!url)('attaques et mini-jeux', () => {
  const pool = new pg.Pool({ connectionString: url });
  const env = testEnv();
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await importGeonames(pool, files);
    app = await buildApp(env, { db: pool });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  let n = 0;
  interface Player {
    call: (m: 'GET' | 'POST', path: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  }
  async function newPlayer(country = 'FR'): Promise<Player> {
    const ip = `10.1.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/guest',
      headers: { 'x-forwarded-for': ip },
      payload: { countryCode: country },
    });
    const cookie = res.cookies.find((c) => c.name === 'conquest_sid')!.value;
    return {
      call: (method, path, payload) =>
        app.inject({
          method,
          url: `/api${path}`,
          headers: { 'x-forwarded-for': ip },
          cookies: { conquest_sid: cookie },
          ...(payload === undefined ? {} : { payload: payload as object }),
        }),
    };
  }

  /** Les parties démarrées par un même joueur sont espacées par un cooldown : on le lève pour les tests. */
  const clearCooldown = () =>
    pool.query(`UPDATE attacks SET started_at = started_at - interval '10 seconds'`);
  /** Simule « 31 s de jeu réel » en antidatant le démarrage. */
  const age = (id: string, seconds: number) =>
    pool.query(`UPDATE attacks SET started_at = now() - make_interval(secs => $2) WHERE id = $1`, [
      id,
      seconds,
    ]);

  const start = async (p: Player, cityId = BERLIN) => {
    const res = await p.call('POST', '/attacks', { cityId, minigame: 'reflex' });
    return { res, body: res.json<AttackStartResponse<ReflexParams>>() };
  };

  /** Joueur « humain » : clique chaque cible avec ~300-420 ms de réaction. */
  const humanInput = (seed: string): ReflexInput => ({
    clicks: reflexGame.generate(seed).targets.map((t, i) => ({
      t: t.appearAt + 300 + ((i * 37) % 120),
      x: t.x + t.radius * 0.2 * (((i * 13) % 7) / 7 - 0.5),
      y: t.y,
    })),
  });

  describe('démarrage', () => {
    it('exige une session (401) et une faction', async () => {
      const anon = await app.inject({
        method: 'POST',
        url: '/api/attacks',
        payload: { cityId: BERLIN },
      });
      expect(anon.statusCode).toBe(401);
    });

    it('crée une partie : graine HMAC dérivée de l’id, paramètres déterministes', async () => {
      const p = await newPlayer('FR');
      const { res, body } = await start(p);
      expect(res.statusCode).toBe(201);
      expect(body.seed).toBe(deriveSeed(env.SESSION_SECRET, body.attackId));
      expect(body.params).toEqual(reflexGame.generate(body.seed));
      expect(body.city).toEqual({ id: BERLIN, name: 'Berlin' });
      expect(body.durationMs).toBe(30_000);
    });

    it('refuse une ville ou un jeu inconnu ; attaquer sa propre ville est permis (défense)', async () => {
      const p = await newPlayer('FR');
      expect((await p.call('POST', '/attacks', { cityId: 1 })).statusCode).toBe(404);
      expect(
        (await p.call('POST', '/attacks', { cityId: BERLIN, minigame: 'poker' })).statusCode,
      ).toBe(400);
      expect((await p.call('POST', '/attacks', { cityId: PARIS })).statusCode).toBe(201);
    });

    it('cooldown entre deux parties (429) ; une partie ouverte est abandonnée au redémarrage', async () => {
      const p = await newPlayer('FR');
      const first = await start(p);
      expect((await p.call('POST', '/attacks', { cityId: BERLIN })).statusCode).toBe(429);
      await clearCooldown();
      const second = await start(p);
      expect(second.res.statusCode).toBe(201);
      const old = await p.call('GET', `/attacks/${first.body.attackId}`);
      expect(old.json<{ status: string }>().status).toBe('abandoned');
      // Soumettre une partie abandonnée est refusé.
      const late = await p.call('POST', `/attacks/${first.body.attackId}/submit`, {
        input: { clicks: [] },
      });
      expect(late.statusCode).toBe(409);
    });
  });

  describe('soumission', () => {
    it('une partie jouée en temps réel est validée et scorée par le serveur', async () => {
      const p = await newPlayer('FR');
      const { body } = await start(p);
      await age(body.attackId, 31);
      const res = await p.call('POST', `/attacks/${body.attackId}/submit`, {
        input: humanInput(body.seed),
      });
      expect(res.statusCode).toBe(200);
      const result = res.json<AttackResult>();
      const expected = reflexGame.validate(body.seed, humanInput(body.seed));
      expect(result).toMatchObject({
        validated: true,
        score: expected.score,
        maxScore: expected.maxScore,
      });
      expect(result.rating).toMatch(/[SAB]/);
      expect(result.stats['hits']).toBe(expected.stats['hits']);
      // Les drapeaux d'analyse ne fuitent jamais vers le client.
      expect(res.body).not.toContain('flags');
      expect(res.body).not.toContain('hard:');
    });

    it('le client ne peut pas imposer son score : le champ est ignoré, seules les actions comptent', async () => {
      const p = await newPlayer('FR');
      const { body } = await start(p);
      await age(body.attackId, 31);
      const res = await p.call('POST', `/attacks/${body.attackId}/submit`, {
        input: { clicks: [], score: 999_999 },
        score: 999_999,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<AttackResult>().score).toBe(0);
    });

    it('soumission instantanée (solution pré-calculée) : rejetée, score 0, flags conservés en base', async () => {
      const p = await newPlayer('FR');
      const { body } = await start(p);
      const res = await p.call('POST', `/attacks/${body.attackId}/submit`, {
        input: humanInput(body.seed),
      });
      expect(res.json<AttackResult>()).toMatchObject({ validated: false, score: 0 });
      const row = await pool.query<{ flags: string[]; validated: boolean }>(
        'SELECT flags, validated FROM attacks WHERE id = $1',
        [body.attackId],
      );
      expect(row.rows[0]?.flags).toEqual(
        expect.arrayContaining(['hard:too_fast', 'hard:future_clicks']),
      );
    });

    it('réactions inhumaines : partie invalidée', async () => {
      const p = await newPlayer('FR');
      const { body } = await start(p);
      await age(body.attackId, 31);
      const bot: ReflexInput = {
        clicks: body.params.targets.map((t) => ({ t: t.appearAt + 20, x: t.x, y: t.y })),
      };
      const res = await p.call('POST', `/attacks/${body.attackId}/submit`, { input: bot });
      expect(res.json<AttackResult>()).toMatchObject({ validated: false, score: 0 });
    });

    it('trop tardif : rejeté', async () => {
      const p = await newPlayer('FR');
      const { body } = await start(p);
      await age(body.attackId, 120);
      const res = await p.call('POST', `/attacks/${body.attackId}/submit`, {
        input: humanInput(body.seed),
      });
      expect(res.json<AttackResult>().validated).toBe(false);
    });

    it('idempotent : un second envoi renvoie le résultat enregistré, sans re-scorer', async () => {
      const p = await newPlayer('FR');
      const { body } = await start(p);
      await age(body.attackId, 31);
      const first = await p.call('POST', `/attacks/${body.attackId}/submit`, {
        input: humanInput(body.seed),
      });
      const retry = await p.call('POST', `/attacks/${body.attackId}/submit`, {
        input: { clicks: [] },
      });
      expect(retry.json()).toEqual(first.json());
      const { rows } = await pool.query<{ score: number }>(
        'SELECT score FROM attacks WHERE id = $1',
        [body.attackId],
      );
      expect(rows[0]?.score).toBe(first.json<AttackResult>().score);
    });

    it('envois simultanés : une seule évaluation, toutes les réponses identiques', async () => {
      const p = await newPlayer('FR');
      const { body } = await start(p);
      await age(body.attackId, 31);
      const payload = { input: humanInput(body.seed) };
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          p.call('POST', `/attacks/${body.attackId}/submit`, payload),
        ),
      );
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      expect(new Set(results.map((r) => r.body)).size).toBe(1);
    });

    it('forme invalide : 400 sans consommer la partie (le client peut réessayer)', async () => {
      const p = await newPlayer('FR');
      const { body } = await start(p);
      const bad = await p.call('POST', `/attacks/${body.attackId}/submit`, {
        input: { clicks: [{ t: -1, x: 0, y: 0 }] },
      });
      expect(bad.statusCode).toBe(400);
      expect(
        (await p.call('GET', `/attacks/${body.attackId}`)).json<{ status: string }>().status,
      ).toBe('started');
      await age(body.attackId, 31);
      const ok = await p.call('POST', `/attacks/${body.attackId}/submit`, {
        input: humanInput(body.seed),
      });
      expect(ok.json<AttackResult>().validated).toBe(true);
    });

    it('la partie d’un autre joueur est invisible (404) : pas de vol ni de lecture croisée', async () => {
      const a = await newPlayer('FR');
      const b = await newPlayer('FR');
      const { body } = await start(a);
      await age(body.attackId, 31);
      expect(
        (await b.call('POST', `/attacks/${body.attackId}/submit`, { input: { clicks: [] } }))
          .statusCode,
      ).toBe(404);
      expect((await b.call('GET', `/attacks/${body.attackId}`)).statusCode).toBe(404);
      expect((await a.call('GET', `/attacks/pas-un-uuid`)).statusCode).toBe(400);
    });
  });

  describe('autres épreuves : quiz géo et mémoire', () => {
    const startGame = async (p: Player, minigame: string) => {
      await clearCooldown();
      const res = await p.call('POST', '/attacks', { cityId: BERLIN, minigame });
      return { res, body: res.json<AttackStartResponse<QuizParams & MemoryParams>>() };
    };
    const quizInput = (seed: string, correct: number) => {
      const key = __answerKey(seed);
      return {
        answers: Array.from({ length: QUIZ.questions }, (_, q) => ({
          q,
          a: q < correct ? key[q]! : (key[q]! + 1) % QUIZ.options,
          t: 1_800 * (q + 1) + ((q * 211) % 500),
        })),
      };
    };
    /** Joueur « humain » de la mémoire : `rounds` manches, éventuellement une erreur à l'appui `failAt`. */
    const memoryTaps = (seed: string, rounds: number, failAt = -1) => {
      const params = memoryGame.generate(seed);
      const taps: { pad: number; t: number }[] = [];
      let startedAt: number = params.startDelayMs;
      let n = 0;
      for (let r = 0; r < rounds; r++) {
        const length = params.firstLength + r;
        let t = startedAt + length * params.stepMs + 400 + ((r * 37) % 60);
        for (let i = 0; i < length; i++) {
          const wrong = n === failAt;
          taps.push({
            pad: wrong ? (params.sequence[i]! + 1) % MEMORY.pads : params.sequence[i]!,
            t,
          });
          n++;
          if (wrong) return taps;
          if (i < length - 1) t += 280 + ((i * 53 + r * 17) % 90);
        }
        startedAt = t + params.nextRoundDelayMs;
      }
      return taps;
    };

    it('le quiz ne révèle jamais la bonne réponse au client', async () => {
      const p = await newPlayer('FR');
      const { res, body } = await startGame(p, 'quiz');
      expect(res.statusCode).toBe(201);
      expect(body.minigame).toBe('quiz');
      expect(body.params.questions).toHaveLength(QUIZ.questions);
      expect(res.body).not.toContain('correct');
      expect(res.body).not.toContain('answers');
    });

    it('score un quiz joué en temps réel, avec la revue des réponses', async () => {
      const p = await newPlayer('FR');
      const { body } = await startGame(p, 'quiz');
      await age(body.attackId, 31);
      const res = await p.call('POST', `/attacks/${body.attackId}/submit`, {
        input: quizInput(body.seed, 7),
      });
      const r = res.json<AttackResult>();
      expect(r).toMatchObject({ validated: true, minigame: 'quiz' });
      expect(r.stats).toMatchObject({ correct: 7, wrong: 3, mask: 0b1111111 });
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(r.maxScore);
    });

    it('accepte un quiz terminé avant le chrono (toutes les questions répondues)', async () => {
      const p = await newPlayer('FR');
      const { body } = await startGame(p, 'quiz');
      await age(body.attackId, 21); // 10 réponses en ~19 s : légitime
      const res = await p.call('POST', `/attacks/${body.attackId}/submit`, {
        input: quizInput(body.seed, 10),
      });
      expect(res.json<AttackResult>()).toMatchObject({ validated: true });
    });

    it('rejette un quiz soumis instantanément (réponses pré-calculées depuis la graine)', async () => {
      const p = await newPlayer('FR');
      const { body } = await startGame(p, 'quiz');
      const res = await p.call('POST', `/attacks/${body.attackId}/submit`, {
        input: quizInput(body.seed, 10),
      });
      expect(res.json<AttackResult>()).toMatchObject({ validated: false, score: 0 });
    });

    it('score une mémoire jouée jusqu’au bout du chrono', async () => {
      const p = await newPlayer('FR');
      const { body } = await startGame(p, 'memory');
      expect(body.params.sequence).toHaveLength(MEMORY.maxLength);
      await age(body.attackId, 31);
      const res = await p.call('POST', `/attacks/${body.attackId}/submit`, {
        input: { taps: memoryTaps(body.seed, 3) },
      });
      const r = res.json<AttackResult>();
      expect(r).toMatchObject({ validated: true, minigame: 'memory' });
      expect(r.stats).toMatchObject({ rounds: 3, failed: 0 });
      expect(r.score).toBeGreaterThan(0);
    });

    it('accepte une mémoire terminée tôt par une erreur, et garde les manches réussies', async () => {
      const p = await newPlayer('FR');
      const { body } = await startGame(p, 'memory');
      await age(body.attackId, 14);
      const res = await p.call('POST', `/attacks/${body.attackId}/submit`, {
        input: { taps: memoryTaps(body.seed, 3, 9) },
      });
      expect(res.json<AttackResult>()).toMatchObject({
        validated: true,
        stats: { rounds: 2, failed: 1 },
      });
    });

    it('rejette une mémoire jouée « trop tôt » : on ne peut pas finir avant la durée sans erreur', async () => {
      const p = await newPlayer('FR');
      const { body } = await startGame(p, 'memory');
      await age(body.attackId, 14);
      const res = await p.call('POST', `/attacks/${body.attackId}/submit`, {
        input: { taps: memoryTaps(body.seed, 3) },
      });
      expect(res.json<AttackResult>().validated).toBe(false);
    });

    it('tire une épreuve au hasard quand le joueur ne choisit pas, parmi toutes celles qui existent', async () => {
      const p = await newPlayer('FR');
      const seen = new Set<string>();
      for (let i = 0; i < 40 && seen.size < 3; i++) {
        await clearCooldown();
        const res = await p.call('POST', '/attacks', { cityId: BERLIN });
        seen.add(res.json<AttackStartResponse>().minigame);
      }
      expect([...seen].sort()).toEqual(['memory', 'quiz', 'reflex']);
    });

    it('refuse une forme d’entrée propre à un autre jeu (400, sans consommer la partie)', async () => {
      const p = await newPlayer('FR');
      const { body } = await startGame(p, 'quiz');
      const bad = await p.call('POST', `/attacks/${body.attackId}/submit`, {
        input: { clicks: [] },
      });
      expect(bad.statusCode).toBe(400);
      expect(
        (await p.call('GET', `/attacks/${body.attackId}`)).json<{ status: string }>().status,
      ).toBe('started');
    });
  });
});
