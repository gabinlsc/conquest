import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Sondes lues à chaque scrape de /metrics (jauges « instantanées »). */
export interface MetricProbes {
  online?: () => number;
  redisUp?: () => boolean;
  pendingWrites?: () => Promise<number>;
  seasonId?: () => Promise<number>;
}

/**
 * Métriques Prometheus. Un registre PAR instance (pas de global) : les tests peuvent créer plusieurs
 * applications sans collision de noms. Toutes les métriques sont préfixées `conquest_`.
 */
export class Metrics {
  readonly registry = new Registry();
  private readonly http: Histogram<'method' | 'route' | 'status'>;
  private readonly attacks: Counter<'outcome'>;
  private readonly captures: Counter;
  private readonly influence: Counter;
  private readonly flags: Counter<'flag'>;
  private readonly bots: Counter<'kind'>;
  private readonly alerts: Counter<'kind'>;
  private probes: MetricProbes = {};

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'conquest_' });
    this.http = new Histogram({
      name: 'conquest_http_request_duration_seconds',
      help: 'Durée des requêtes HTTP',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [this.registry],
    });
    this.attacks = new Counter({
      name: 'conquest_attacks_total',
      help: 'Parties par issue (started, validated, invalid, ghost, pending)',
      labelNames: ['outcome'],
      registers: [this.registry],
    });
    this.captures = new Counter({
      name: 'conquest_captures_total',
      help: 'Villes capturées',
      registers: [this.registry],
    });
    this.influence = new Counter({
      name: 'conquest_influence_points_total',
      help: "Points d'influence appliqués",
      registers: [this.registry],
    });
    this.flags = new Counter({
      name: 'conquest_anticheat_flags_total',
      help: 'Drapeaux anti-triche levés, par type',
      labelNames: ['flag'],
      registers: [this.registry],
    });
    this.bots = new Counter({
      name: 'conquest_bot_actions_total',
      help: 'Actions des bots',
      labelNames: ['kind'],
      registers: [this.registry],
    });
    this.alerts = new Counter({
      name: 'conquest_alerts_total',
      help: 'Alertes « ta ville est attaquée » envoyées ou ignorées (anti-spam)',
      labelNames: ['kind'],
      registers: [this.registry],
    });

    const probes = () => this.probes;
    const gauge = (name: string, help: string, read: () => Promise<number> | number) =>
      new Gauge({
        name,
        help,
        registers: [this.registry],
        async collect() {
          try {
            this.set(await read());
          } catch {
            // sonde indisponible : la valeur précédente est conservée
          }
        },
      });
    gauge('conquest_ws_clients', 'Clients Socket.IO connectés', () => probes().online?.() ?? 0);
    gauge('conquest_redis_up', 'Redis joignable (1) ou non (0)', () =>
      probes().redisUp?.() ? 1 : 0,
    );
    gauge(
      'conquest_writebehind_pending',
      'Villes en attente de persistance Postgres',
      () => probes().pendingWrites?.() ?? 0,
    );
    gauge(
      'conquest_season_id',
      'Identifiant de la saison active',
      () => probes().seasonId?.() ?? 0,
    );
  }

  bind(probes: MetricProbes): void {
    this.probes = probes;
  }

  observeHttp(method: string, route: string, status: number, seconds: number): void {
    this.http.observe({ method, route, status: String(status) }, seconds);
  }
  attack(outcome: 'started' | 'validated' | 'invalid' | 'ghost' | 'pending'): void {
    this.attacks.inc({ outcome });
  }
  capture(influenceGain: number): void {
    this.captures.inc();
    this.influence.inc(influenceGain);
  }
  influencePoints(n: number): void {
    this.influence.inc(n);
  }
  flag(flag: string): void {
    this.flags.inc({ flag });
  }
  botAction(kind: 'attack' | 'defend'): void {
    this.bots.inc({ kind });
  }
  alert(kind: 'sent' | 'throttled'): void {
    this.alerts.inc({ kind });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}

const PRIVATE = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^::1$/,
  /^fc/i,
  /^fd/i,
  /^::ffff:(127|10|192\.168)\./,
];
/** Vrai pour une adresse du réseau privé (Prometheus dans Docker, sonde locale). */
export const isPrivateIp = (ip: string): boolean => PRIVATE.some((re) => re.test(ip));
