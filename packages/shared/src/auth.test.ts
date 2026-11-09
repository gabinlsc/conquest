import { describe, expect, it } from 'vitest';
import {
  createClanSchema,
  displayNameSchema,
  guessCountryFromAcceptLanguage,
  guestSchema,
  patchMeSchema,
} from './auth';

describe('guessCountryFromAcceptLanguage', () => {
  it.each([
    ['fr-FR,fr;q=0.9,en;q=0.8', 'FR'],
    ['en-us', 'US'],
    ['fr,en-GB;q=0.8', 'GB'],
    ['fr', null],
    ['', null],
    [undefined, null],
    ['zh-Hans-CN', null],
  ])('%s -> %s', (header, expected) => {
    expect(guessCountryFromAcceptLanguage(header)).toBe(expected);
  });
});

describe('schémas', () => {
  it('displayName accepte les accents et rejette les caractères spéciaux', () => {
    expect(displayNameSchema.safeParse('Éloïse_42').success).toBe(true);
    expect(displayNameSchema.safeParse('<script>').success).toBe(false);
    expect(displayNameSchema.safeParse('a').success).toBe(false);
  });
  it('guest normalise le pays en majuscules', () => {
    expect(guestSchema.parse({ countryCode: 'fr' }).countryCode).toBe('FR');
  });
  it('patchMe exige au moins un champ', () => {
    expect(patchMeSchema.safeParse({}).success).toBe(false);
    expect(patchMeSchema.safeParse({ displayName: 'Zoé' }).success).toBe(true);
  });
  it('createClan : clan ouvert par défaut, couleur validée', () => {
    expect(createClanSchema.parse({ name: 'Les Aigles' }).open).toBe(true);
    expect(createClanSchema.safeParse({ name: 'Les Aigles', color: 'red' }).success).toBe(false);
  });
});
