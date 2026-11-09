'use client';

import { useState } from 'react';
import { OAUTH_PROVIDERS, type OAuthProvider } from '@conquest/shared';
import { ApiError, createGuest, patchMe } from '@/lib/api';
import { useAuth } from './AuthProvider';
import { CountrySelect } from './CountrySelect';
import { Blob, Spark, Star } from './Decor';

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
    <div className="absolute inset-0 z-20 grid place-items-center bg-ink/40 p-4 backdrop-blur-[2px]">
      <div className="relative w-full max-w-sm">
        <Star className="absolute -right-6 -top-8 h-16 w-16 rotate-12" />
        <Spark className="absolute -left-7 top-24 h-12 w-12" />
        <Blob className="absolute -bottom-7 -right-5 h-14 w-14" fill="#7BE0AD" />
        <div className="card relative bg-cream p-6">
          <span className="pill bg-sky">Salut, joueur !</span>
          <h2 className="mt-2 text-3xl uppercase leading-none">
            {mode === 'guest' ? (
              <>
                Rejoins la <span className="hl">conquête</span>
              </>
            ) : (
              <>
                Choisis ta <span className="hl">nation</span>
              </>
            )}
          </h2>
          <p className="mt-2 text-sm font-medium text-ink/70">
            Tu combats pour la faction de ton pays. Tu pourras fonder ou rejoindre un clan ensuite.
          </p>

          <div className="mt-4 space-y-3">
            {mode === 'guest' && (
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={24}
                placeholder="Pseudo (facultatif)"
                className="field"
              />
            )}
            <CountrySelect value={country} onChange={setCountry} disabled={busy} />
            {error && <p className="card-sm bg-coral px-3 py-2 text-sm font-bold">{error}</p>}
            <button
              disabled={!country || busy}
              onClick={() => void submit()}
              className="btn btn-banana w-full text-lg"
            >
              {mode === 'guest' ? 'Jouer en invité' : 'Valider'}
            </button>
          </div>

          {mode === 'guest' && providers.length > 0 && (
            <div className="mt-4 border-t-3 border-dashed border-ink pt-4">
              <p className="mb-2 text-center text-xs font-bold uppercase tracking-wide">
                ou connecte-toi
              </p>
              <div className="flex gap-2">
                {providers.map((p) => (
                  // Navigation pleine page (pas fetch) : le flux OAuth redirige vers le fournisseur.
                  <a key={p} href={`/api/auth/oauth/${p}/start`} className="btn btn-white flex-1">
                    {PROVIDER_LABEL[p]}
                  </a>
                ))}
              </div>
            </div>
          )}

          {onClose && (
            <button
              onClick={onClose}
              className="mt-4 w-full text-center text-sm font-bold underline decoration-coral decoration-4 underline-offset-4"
            >
              Explorer la carte sans jouer
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
