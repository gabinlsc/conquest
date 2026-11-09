'use client';

import { Trophy, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  LeaderboardEntry,
  LeaderboardKind,
  LeaderboardResponse,
  MyRanks,
  PastSeason,
} from '@conquest/shared';
import { fetchLeaderboard, fetchMyRanks, fetchPastSeasons } from '@/lib/api';
import { useAuth } from './AuthProvider';
import { CountrySelect } from './CountrySelect';
import { Star } from './Decor';

const TABS: { kind: LeaderboardKind; label: string }[] = [
  { kind: 'players', label: 'Joueurs' },
  { kind: 'nations', label: 'Nations' },
  { kind: 'clans', label: 'Clans' },
];

const MEDAL = ['bg-banana', 'bg-white', 'bg-peach'];

export function countdown(endsAt: string, now: number): string {
  const ms = Math.max(0, new Date(endsAt).getTime() - now);
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (d > 0) return `${d} j ${h} h`;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export function LeaderboardPanel({ onClose, now }: { onClose: () => void; now: number }) {
  const { me } = useAuth();
  const [kind, setKind] = useState<LeaderboardKind>('players');
  const [country, setCountry] = useState('');
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [mine, setMine] = useState<MyRanks | null>(null);
  const [past, setPast] = useState<PastSeason[]>([]);
  const [error, setError] = useState(false);
  const [showPast, setShowPast] = useState(false);

  // Rafraîchissement toutes les 30 s tant que le panneau est ouvert.
  useEffect(() => {
    const abort = new AbortController();
    const load = () => {
      fetchLeaderboard(
        kind,
        kind === 'players' ? country || undefined : undefined,
        abort.signal,
      ).then(
        (r) => {
          setData(r);
          setError(false);
        },
        () => !abort.signal.aborted && setError(true),
      );
      if (me?.user) fetchMyRanks(abort.signal).then(setMine, () => undefined);
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      abort.abort();
      clearInterval(t);
    };
  }, [kind, country, me?.user]);

  useEffect(() => {
    fetchPastSeasons().then(setPast, () => undefined);
  }, []);

  const myId = kind === 'players' ? me?.user?.id : me?.faction ? String(me.faction.id) : undefined;
  const myRank = kind === 'players' ? mine?.player : mine?.faction;

  return (
    <aside className="card absolute right-4 top-20 z-20 flex max-h-[calc(100%-6rem)] w-[min(92vw,24rem)] flex-col p-4">
      <Star className="absolute -left-5 -top-6 h-12 w-12 -rotate-12" />
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-2xl uppercase">
            <Trophy className="h-6 w-6" strokeWidth={3} /> <span className="hl">Classements</span>
          </h2>
          {data && (
            <p className="mt-1 text-xs font-bold text-ink/70">
              {data.season.name} · fin dans {countdown(data.season.endsAt, now)}
            </p>
          )}
        </div>
        <button aria-label="Fermer" onClick={onClose} className="btn !p-1">
          <X className="h-4 w-4" strokeWidth={3} />
        </button>
      </div>

      <div className="mt-3 flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.kind}
            className={`tab ${kind === t.kind ? 'tab-on' : ''}`}
            onClick={() => setKind(t.kind)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {kind === 'players' && (
        <div className="mt-2">
          <CountrySelect value={country} onChange={setCountry} placeholder="🌍 Tous les pays" />
        </div>
      )}

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
        {error && (
          <p className="card-sm bg-coral px-3 py-2 text-sm font-bold">Classement indisponible.</p>
        )}
        {data && data.entries.length === 0 && (
          <p className="text-sm font-medium text-ink/60">
            Personne n’a encore marqué de points. À toi de jouer !
          </p>
        )}
        <ol className="space-y-1.5">
          {data?.entries.map((e) => (
            <Row key={e.id} entry={e} mine={e.id === myId} showCountry={kind === 'players'} />
          ))}
        </ol>
      </div>

      {me?.user && (
        <p className="card-sm mt-3 bg-sky px-3 py-1.5 text-sm font-bold">
          {myRank ? (
            <>
              Ton rang : <span className="font-display text-lg">#{myRank.rank}</span> ·{' '}
              {myRank.points.toLocaleString('fr-FR')} pts
            </>
          ) : (
            'Joue une partie pour entrer au classement.'
          )}
        </p>
      )}

      {past.length > 0 && (
        <div className="mt-2">
          <button
            className="text-xs font-bold underline decoration-coral decoration-4 underline-offset-4"
            onClick={() => setShowPast((v) => !v)}
          >
            {showPast ? 'Masquer' : 'Voir'} les saisons passées
          </button>
          {showPast && (
            <ul className="mt-2 space-y-1 text-xs font-medium">
              {past.map((s) => (
                <li key={s.id} className="card-sm px-2 py-1">
                  <strong>{s.name}</strong> — 🥇 {s.winners.players[0]?.name ?? '—'} · 🏴{' '}
                  {s.winners.factions[0]?.name ?? '—'}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}

function Row({
  entry,
  mine,
  showCountry,
}: {
  entry: LeaderboardEntry;
  mine: boolean;
  showCountry: boolean;
}) {
  return (
    <li
      className={`flex items-center gap-2 rounded-xl border-2 border-ink px-2 py-1 text-sm ${mine ? 'bg-mint shadow-pop-sm' : 'bg-white'}`}
    >
      <span
        className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg border-2 border-ink font-display text-sm font-bold ${MEDAL[entry.rank - 1] ?? 'bg-cream'}`}
      >
        {entry.rank}
      </span>
      {entry.color && (
        <span
          className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-ink"
          style={{ background: entry.color }}
        />
      )}
      <span className="min-w-0 flex-1 truncate font-bold">{entry.name}</span>
      {showCountry && entry.countryCode && (
        <span className="rounded-md bg-ink px-1.5 text-[11px] font-bold text-white">
          {entry.countryCode}
        </span>
      )}
      <span className="font-mono text-xs font-bold">{entry.points.toLocaleString('fr-FR')}</span>
    </li>
  );
}
