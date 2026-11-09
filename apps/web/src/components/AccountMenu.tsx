'use client';

import { useCallback, useEffect, useState } from 'react';
import { OAUTH_PROVIDERS, colorForKey, type ClanSummary, type MyFaction } from '@conquest/shared';
import { ApiError, createClan, joinClan, leaveClan, listClans, logout, patchMe } from '@/lib/api';
import { useAuth } from './AuthProvider';
import { CountrySelect } from './CountrySelect';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Erreur réseau, réessaie.');

export function AccountMenu({ onPlay }: { onPlay: () => void }) {
  const { me, status, refresh } = useAuth();
  const [open, setOpen] = useState(false);

  if (status !== 'ready' || !me) return null;
  if (!me.user) {
    return (
      <button
        onClick={onPlay}
        className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold shadow hover:bg-sky-500"
      >
        Jouer
      </button>
    );
  }

  const { user, faction } = me;
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2 text-sm shadow hover:bg-slate-800"
      >
        <span
          className="inline-block h-3 w-3 rounded-full"
          style={{ background: faction?.color ?? '#5b6785' }}
        />
        <span className="font-semibold">{user.displayName}</span>
        {faction && <span className="hidden text-slate-400 sm:inline">· {faction.name}</span>}
      </button>
      {open && <Drawer onClose={() => setOpen(false)} onChanged={refresh} />}
    </div>
  );
}

function Drawer({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: (next?: undefined) => Promise<void>;
}) {
  const { me } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await onChanged();
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  if (!me?.user) return null;
  const { user, faction } = me;
  const oauthLinks = OAUTH_PROVIDERS.filter((p) => me.providers.includes(p));

  return (
    <div className="absolute right-0 top-12 z-10 max-h-[80vh] w-80 space-y-4 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900/95 p-4 shadow-xl backdrop-blur">
      <div className="flex items-start justify-between">
        <div>
          <p className="font-bold">{user.displayName}</p>
          <p className="text-xs text-slate-400">
            {user.kind === 'guest' ? 'Compte invité' : 'Compte connecté'}
          </p>
        </div>
        <button aria-label="Fermer" onClick={onClose} className="text-slate-400 hover:text-white">
          ✕
        </button>
      </div>

      {error && <p className="rounded bg-red-950/60 p-2 text-sm text-red-300">{error}</p>}

      {faction ? (
        <FactionCard faction={faction} busy={busy} onLeave={() => void run(leaveClan)} />
      ) : (
        <p className="text-sm text-slate-400">Choisis ton pays pour rejoindre une faction.</p>
      )}

      {faction?.kind !== 'clan' && <ClanBrowser busy={busy} run={run} />}

      <section className="space-y-2 border-t border-slate-800 pt-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Nation</h3>
        <CountrySelect
          value={user.countryCode ?? ''}
          disabled={busy}
          onChange={(code) => code && void run(() => patchMe({ countryCode: code }))}
        />
        <p className="text-xs text-slate-500">Changement possible une fois par semaine.</p>
      </section>

      {user.kind === 'guest' && oauthLinks.length > 0 && (
        <section className="space-y-2 border-t border-slate-800 pt-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Sauvegarder ma progression
          </h3>
          <div className="flex gap-2">
            {oauthLinks.map((p) => (
              <a
                key={p}
                href={`/api/auth/oauth/${p}/start`}
                className="flex-1 rounded-lg border border-slate-700 py-2 text-center text-sm capitalize hover:bg-slate-800"
              >
                {p}
              </a>
            ))}
          </div>
        </section>
      )}

      <button
        disabled={busy}
        onClick={() =>
          void logout().then(async () => {
            onClose();
            await onChanged();
          })
        }
        className="w-full rounded-lg border border-slate-700 py-2 text-sm text-slate-300 hover:bg-slate-800"
      >
        Se déconnecter
      </button>
    </div>
  );
}

function FactionCard({
  faction,
  busy,
  onLeave,
}: {
  faction: MyFaction;
  busy: boolean;
  onLeave: () => void;
}) {
  return (
    <section className="rounded-lg border border-slate-700 p-3">
      <div className="flex items-center gap-2">
        <span className="inline-block h-4 w-4 rounded-full" style={{ background: faction.color }} />
        <span className="font-semibold">{faction.name}</span>
        <span className="ml-auto text-xs text-slate-400">
          {faction.kind === 'clan' ? 'Clan' : 'Nation'}
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-400">
        {faction.memberCount.toLocaleString('fr-FR')} joueur{faction.memberCount > 1 ? 's' : ''}
        {faction.role === 'owner' && ' · tu en es le chef'}
      </p>
      {faction.inviteCode && (
        <p className="mt-2 text-xs text-slate-400">
          Code d’invitation :{' '}
          <code className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-sky-300">
            {faction.inviteCode}
          </code>{' '}
          ({faction.open ? 'clan ouvert' : 'clan fermé'})
        </p>
      )}
      {faction.kind === 'clan' && (
        <button
          disabled={busy}
          onClick={() => {
            if (window.confirm('Quitter ce clan ?')) onLeave();
          }}
          className="mt-3 w-full rounded border border-red-900 py-1.5 text-sm text-red-300 hover:bg-red-950/50"
        >
          Quitter le clan
        </button>
      )}
    </section>
  );
}

function ClanBrowser({
  busy,
  run,
}: {
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [tab, setTab] = useState<'join' | 'create'>('join');
  const [q, setQ] = useState('');
  const [clans, setClans] = useState<ClanSummary[]>([]);
  const [codes, setCodes] = useState<Record<number, string>>({});
  const [name, setName] = useState('');
  const [color, setColor] = useState('');
  const [isOpen, setIsOpen] = useState(true);

  useEffect(() => {
    if (tab !== 'join') return;
    const abort = new AbortController();
    const t = setTimeout(() => {
      listClans(q.trim(), abort.signal)
        .then((r) => setClans(r.items))
        .catch(() => undefined);
    }, 250);
    return () => {
      clearTimeout(t);
      abort.abort();
    };
  }, [q, tab]);

  const tabCls = (t: typeof tab) =>
    `flex-1 rounded py-1.5 text-sm ${tab === t ? 'bg-slate-700 font-semibold' : 'text-slate-400 hover:bg-slate-800'}`;

  return (
    <section className="space-y-3 border-t border-slate-800 pt-3">
      <div className="flex gap-1">
        <button className={tabCls('join')} onClick={() => setTab('join')}>
          Rejoindre un clan
        </button>
        <button className={tabCls('create')} onClick={() => setTab('create')}>
          Créer
        </button>
      </div>

      {tab === 'join' ? (
        <>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher un clan…"
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm outline-none focus:border-sky-500"
          />
          <ul className="space-y-2">
            {clans.length === 0 && (
              <li className="text-sm text-slate-500">Aucun clan pour l’instant.</li>
            )}
            {clans.map((c) => (
              <li key={c.id} className="rounded-lg border border-slate-800 p-2 text-sm">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-3 w-3 rounded-full"
                    style={{ background: c.color }}
                  />
                  <span className="font-semibold">{c.name}</span>
                  <span className="ml-auto text-xs text-slate-500">
                    {c.memberCount} 👥 · {c.cityCount} 🏙
                  </span>
                </div>
                <div className="mt-2 flex gap-2">
                  {!c.open && (
                    <input
                      value={codes[c.id] ?? ''}
                      onChange={(e) => setCodes({ ...codes, [c.id]: e.target.value })}
                      maxLength={8}
                      placeholder="Code"
                      className="w-24 rounded border border-slate-700 bg-slate-800 px-2 py-1 font-mono text-xs uppercase"
                    />
                  )}
                  <button
                    disabled={busy || (!c.open && (codes[c.id]?.length ?? 0) !== 8)}
                    onClick={() => void run(() => joinClan(c.id, codes[c.id]))}
                    className="ml-auto rounded bg-sky-700 px-3 py-1 text-xs font-semibold hover:bg-sky-600 disabled:opacity-40"
                  >
                    Rejoindre
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              createClan({ name: name.trim(), open: isOpen, ...(color ? { color } : {}) }),
            );
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            minLength={3}
            maxLength={24}
            required
            placeholder="Nom du clan"
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm outline-none focus:border-sky-500"
          />
          <label className="flex items-center gap-3 text-sm">
            Couleur
            <input
              type="color"
              value={color || colorForKey(name.trim().toLowerCase() || 'clan')}
              onChange={(e) => setColor(e.target.value)}
              className="h-8 w-12 cursor-pointer rounded border border-slate-700 bg-transparent"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isOpen} onChange={(e) => setIsOpen(e.target.checked)} />
            Ouvert à tous (sinon, sur invitation)
          </label>
          <button
            type="submit"
            disabled={busy || name.trim().length < 3}
            className="w-full rounded-lg bg-sky-600 py-2 text-sm font-semibold hover:bg-sky-500 disabled:opacity-40"
          >
            Fonder le clan
          </button>
        </form>
      )}
    </section>
  );
}
