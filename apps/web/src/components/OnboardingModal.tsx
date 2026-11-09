'use client';

import { useState } from 'react';
import { OAUTH_PROVIDERS, type OAuthProvider } from '@conquest/shared';
import { ApiError, createGuest, patchMe } from '@/lib/api';
import { useAuth } from './AuthProvider';
import { CountrySelect } from './CountrySelect';

const PROVIDER_LABEL: Record<OAuthProvider, string> = { google: 'Google', discord: 'Discord' };

const AUTH_ERRORS: Record<string, string> = {
  refused: 'Connexion annulée.',
  expired: 'La connexion a expiré, réessaie.',
  state: 'Connexion invalide, réessaie.',
  failed: 'La connexion a échoué, réessaie.',
};

interface Props {
  /** `country` : compte connecté mais sans pays (OAuth sans indice de pays). */
  mode: 'guest' | 'country';
  onClose?: () => void;
}

export function OnboardingModal({ mode, onClose }: Props) {
  const { me, refresh } = useAuth();
  const [country, setCountry] = useState(me?.countryHint ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const code = new URLSearchParams(window.location.search).get('auth_error');
    return code ? (AUTH_ERRORS[code] ?? 'Connexion impossible.') : null;
  });

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const next =
        mode === 'guest'
          ? await createGuest(country, name.trim() || undefined)
          : await patchMe({ countryCode: country });
      await refresh(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erreur réseau, réessaie.');
    } finally {
      setBusy(false);
    }
  }

  const providers = OAUTH_PROVIDERS.filter((p) => me?.providers.includes(p));

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
        <h2 className="text-xl font-bold">
          {mode === 'guest' ? 'Rejoins la conquête' : 'Choisis ta nation'}
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Tu combats pour la faction de ton pays. Tu pourras fonder ou rejoindre un clan ensuite.
        </p>

        <div className="mt-4 space-y-3">
          {mode === 'guest' && (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={24}
              placeholder="Pseudo (facultatif)"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm outline-none focus:border-sky-500"
            />
          )}
          <CountrySelect value={country} onChange={setCountry} disabled={busy} />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            disabled={!country || busy}
            onClick={() => void submit()}
            className="w-full rounded-lg bg-sky-600 py-2 font-semibold hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {mode === 'guest' ? 'Jouer en invité' : 'Valider'}
          </button>
        </div>

        {mode === 'guest' && providers.length > 0 && (
          <div className="mt-4 border-t border-slate-800 pt-4">
            <p className="mb-2 text-center text-xs text-slate-500">ou connecte-toi</p>
            <div className="flex gap-2">
              {providers.map((p) => (
                // Navigation pleine page (pas fetch) : le flow OAuth redirige vers le fournisseur.
                <a
                  key={p}
                  href={`/api/auth/oauth/${p}/start`}
                  className="flex-1 rounded-lg border border-slate-700 py-2 text-center text-sm hover:bg-slate-800"
                >
                  {PROVIDER_LABEL[p]}
                </a>
              ))}
            </div>
          </div>
        )}

        {onClose && (
          <button
            onClick={onClose}
            className="mt-4 w-full text-center text-xs text-slate-500 hover:text-slate-300"
          >
            Explorer la carte sans jouer
          </button>
        )}
      </div>
    </div>
  );
}
