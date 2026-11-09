'use client';

import { Crown, LogOut, Shield, Users, X } from 'lucide-react';
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
      <button onClick={onPlay} className="btn btn-banana text-lg">
        Jouer
      </button>
    );
  }

  const { user, faction } = me;
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="btn bg-white">
        <span
          className="inline-block h-4 w-4 rounded-full border-2 border-ink"
          style={{ background: faction?.color ?? '#d9d4c3' }}
        />
        <span>{user.displayName}</span>
        {faction && (
          <span className="hidden font-medium text-ink/60 sm:inline">· {faction.name}</span>
        )}
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
    <div className="card absolute right-0 top-14 z-20 max-h-[80vh] w-80 space-y-4 overflow-y-auto p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="font-display text-xl font-bold">{user.displayName}</p>
          <span className="pill bg-mint">
            {user.kind === 'guest' ? 'Compte invité' : 'Compte connecté'}
          </span>
        </div>
        <button aria-label="Fermer" onClick={onClose} className="btn !p-1">
          <X className="h-4 w-4" strokeWidth={3} />
        </button>
      </div>

      {error && <p className="card-sm bg-coral px-3 py-2 text-sm font-bold">{error}</p>}

      {faction ? (
        <FactionCard faction={faction} busy={busy} onLeave={() => void run(leaveClan)} />
      ) : (
        <p className="text-sm font-medium text-ink/70">
          Choisis ton pays pour rejoindre une faction.
        </p>
      )}

      {faction?.kind !== 'clan' && <ClanBrowser busy={busy} run={run} />}

      <section className="space-y-2 border-t-3 border-dashed border-ink pt-3">
        <h3 className="text-sm uppercase tracking-wide">Nation</h3>
        <CountrySelect
          value={user.countryCode ?? ''}
          disabled={busy}
          onChange={(code) => code && void run(() => patchMe({ countryCode: code }))}
        />
        <p className="text-xs font-medium text-ink/60">Changement possible une fois par semaine.</p>
      </section>

      {user.kind === 'guest' && oauthLinks.length > 0 && (
        <section className="space-y-2 border-t-3 border-dashed border-ink pt-3">
          <h3 className="text-sm uppercase tracking-wide">Sauvegarder ma progression</h3>
          <div className="flex gap-2">
            {oauthLinks.map((p) => (
              <a key={p} href={`/api/auth/oauth/${p}/start`} className="btn flex-1 capitalize">
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
        className="btn w-full"
      >
        <LogOut className="h-4 w-4" strokeWidth={3} />
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
    <section className="card-sm p-3" style={{ background: `${faction.color}33` }}>
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-5 w-5 rounded-full border-2 border-ink"
          style={{ background: faction.color }}
        />
        <span className="font-display text-lg font-bold">{faction.name}</span>
        <span className="pill ml-auto bg-white">{faction.kind === 'clan' ? 'Clan' : 'Nation'}</span>
      </div>
      <p className="mt-1 flex items-center gap-1 text-xs font-bold">
        <Users className="h-3.5 w-3.5" strokeWidth={3} />
        {faction.memberCount.toLocaleString('fr-FR')} joueur{faction.memberCount > 1 ? 's' : ''}
        {faction.role === 'owner' && (
          <span className="ml-2 inline-flex items-center gap-1">
            <Crown className="h-3.5 w-3.5" strokeWidth={3} /> chef
          </span>
        )}
      </p>
      {faction.inviteCode && (
        <p className="mt-2 text-xs font-medium">
          Code d’invitation :{' '}
          <code className="rounded-md border-2 border-ink bg-banana px-1.5 py-0.5 font-mono font-bold">
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
          className="btn btn-coral mt-3 w-full !py-1.5 text-sm"
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

  return (
    <section className="space-y-3 border-t-3 border-dashed border-ink pt-3">
      <div className="flex gap-1">
        <button className={`tab ${tab === 'join' ? 'tab-on' : ''}`} onClick={() => setTab('join')}>
          Rejoindre un clan
        </button>
        <button
          className={`tab ${tab === 'create' ? 'tab-on' : ''}`}
          onClick={() => setTab('create')}
        >
          Créer
        </button>
      </div>

      {tab === 'join' ? (
        <>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher un clan…"
            className="field"
          />
          <ul className="space-y-2">
            {clans.length === 0 && (
              <li className="text-sm font-medium text-ink/60">Aucun clan pour l’instant.</li>
            )}
            {clans.map((c) => (
              <li key={c.id} className="card-sm p-2 text-sm">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-3.5 w-3.5 rounded-full border-2 border-ink"
                    style={{ background: c.color }}
                  />
                  <span className="font-display font-bold">{c.name}</span>
                  <span className="ml-auto text-xs font-bold text-ink/60">
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
                      className="field !w-24 !py-1 font-mono text-xs uppercase"
                    />
                  )}
                  <button
                    disabled={busy || (!c.open && (codes[c.id]?.length ?? 0) !== 8)}
                    onClick={() => void run(() => joinClan(c.id, codes[c.id]))}
                    className="btn btn-mint ml-auto !px-3 !py-1 text-xs"
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
            className="field"
          />
          <label className="flex items-center gap-3 text-sm font-bold">
            Couleur
            <input
              type="color"
              value={color || colorForKey(name.trim().toLowerCase() || 'clan')}
              onChange={(e) => setColor(e.target.value)}
              className="h-9 w-14 cursor-pointer rounded-lg border-3 border-ink bg-white p-0.5"
            />
          </label>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={isOpen}
              onChange={(e) => setIsOpen(e.target.checked)}
              className="h-4 w-4 accent-ink"
            />
            Ouvert à tous (sinon, sur invitation)
          </label>
          <button
            type="submit"
            disabled={busy || name.trim().length < 3}
            className="btn btn-banana w-full"
          >
            <Shield className="h-4 w-4" strokeWidth={3} />
            Fonder le clan
          </button>
        </form>
      )}
    </section>
  );
}
