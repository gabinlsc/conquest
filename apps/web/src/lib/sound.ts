/**
 * Effets sonores SYNTHÉTISÉS avec l'API Web Audio : aucun fichier à télécharger, aucune licence, démarrage instantané.
 * Le contexte audio n'est créé qu'au premier geste de l'utilisateur (politique d'autoplay des navigateurs).
 * Le choix muet/son est mémorisé (localStorage, avec repli si indisponible).
 */
const KEY = 'conquest:muted';
let ctx: AudioContext | null = null;
let muted = false;
const listeners = new Set<() => void>();

try {
  muted = window.localStorage.getItem(KEY) === '1';
} catch {
  // stockage indisponible (navigation privée) : son activé par défaut
}

export const isMuted = (): boolean => muted;

export function setMuted(value: boolean): void {
  muted = value;
  try {
    window.localStorage.setItem(KEY, value ? '1' : '0');
  } catch {
    // ignoré
  }
  listeners.forEach((l) => l());
}

export function onMuteChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function audio(): AudioContext | null {
  if (muted) return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** À appeler sur un geste utilisateur : débloque l'audio pour les sons déclenchés plus tard (alertes, captures). */
export function unlockAudio(): void {
  if (!ctx && !muted) audio();
  else if (ctx?.state === 'suspended') void ctx.resume();
}

interface Tone {
  freq: number;
  at?: number;
  dur?: number;
  type?: OscillatorType;
  gain?: number;
  slideTo?: number;
}

function play(tones: Tone[]): void {
  const a = audio();
  if (!a) return;
  const now = a.currentTime;
  for (const t of tones) {
    const start = now + (t.at ?? 0);
    const dur = t.dur ?? 0.12;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = t.type ?? 'sine';
    osc.frequency.setValueAtTime(t.freq, start);
    if (t.slideTo) osc.frequency.exponentialRampToValueAtTime(t.slideTo, start + dur);
    // Enveloppe courte : attaque rapide, extinction douce (évite les « clics »).
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(t.gain ?? 0.1, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g).connect(a.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }
}

/** Gamme pentatonique : toute suite de coups au but sonne juste. */
const PAD_NOTES = [261.63, 293.66, 329.63, 392, 440, 523.25, 587.33, 659.25, 784];
const PENTA = [523.25, 587.33, 659.25, 783.99, 880, 1046.5];

export const sfx = {
  /** `combo` : numéro du coup au but d'affilée, la note monte avec la série. */
  hit: (combo = 0) =>
    play([
      {
        freq: PENTA[combo % PENTA.length]!,
        dur: 0.14,
        type: 'triangle',
        gain: 0.12,
        slideTo: PENTA[combo % PENTA.length]! * 1.5,
      },
    ]),
  miss: () => play([{ freq: 180, dur: 0.16, type: 'sawtooth', gain: 0.07, slideTo: 90 }]),
  tick: () => play([{ freq: 440, dur: 0.08, type: 'square', gain: 0.05 }]),
  go: () =>
    play([
      { freq: 660, dur: 0.1, type: 'square', gain: 0.06 },
      { freq: 880, at: 0.1, dur: 0.22, type: 'square', gain: 0.06 },
    ]),
  win: () =>
    play([
      { freq: 523.25, dur: 0.12, type: 'triangle', gain: 0.1 },
      { freq: 659.25, at: 0.12, dur: 0.12, type: 'triangle', gain: 0.1 },
      { freq: 783.99, at: 0.24, dur: 0.22, type: 'triangle', gain: 0.1 },
    ]),
  capture: () =>
    play([
      { freq: 392, dur: 0.1, type: 'triangle', gain: 0.11 },
      { freq: 523.25, at: 0.1, dur: 0.1, type: 'triangle', gain: 0.11 },
      { freq: 659.25, at: 0.2, dur: 0.1, type: 'triangle', gain: 0.11 },
      { freq: 783.99, at: 0.3, dur: 0.1, type: 'triangle', gain: 0.11 },
      { freq: 1046.5, at: 0.4, dur: 0.4, type: 'triangle', gain: 0.12 },
    ]),
  defeat: () =>
    play([
      { freq: 330, dur: 0.18, type: 'sawtooth', gain: 0.06, slideTo: 220 },
      { freq: 220, at: 0.18, dur: 0.3, type: 'sawtooth', gain: 0.06, slideTo: 110 },
    ]),
  /** Alerte « ta ville est attaquée » : deux notes descendantes, impossible à manquer. */
  alert: () =>
    play([
      { freq: 880, dur: 0.12, type: 'square', gain: 0.07 },
      { freq: 660, at: 0.14, dur: 0.12, type: 'square', gain: 0.07 },
      { freq: 880, at: 0.3, dur: 0.12, type: 'square', gain: 0.07 },
      { freq: 660, at: 0.44, dur: 0.18, type: 'square', gain: 0.07 },
    ]),
  /** Pastille de la mémoire : une note de la gamme par pastille (9 pastilles), ascendante de gauche à droite. */
  pad: (i: number) =>
    play([{ freq: PAD_NOTES[i % PAD_NOTES.length]!, dur: 0.28, type: 'triangle', gain: 0.12 }]),
  right: () =>
    play([
      { freq: 880, dur: 0.1, type: 'triangle', gain: 0.07 },
      { freq: 1175, at: 0.08, dur: 0.14, type: 'triangle', gain: 0.07 },
    ]),
  wrong: () => play([{ freq: 220, dur: 0.3, type: 'sawtooth', gain: 0.08, slideTo: 110 }]),
  click: () => play([{ freq: 620, dur: 0.05, type: 'square', gain: 0.04 }]),
  /** Vague lointaine : discret, pour les captures vues sur la carte. */
  wave: () => play([{ freq: 300, dur: 0.35, type: 'sine', gain: 0.05, slideTo: 600 }]),
};
