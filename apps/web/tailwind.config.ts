import type { Config } from 'tailwindcss';

/**
 * Design system « glsc.fr » : néo-brutalisme joyeux. Fond crème pointillé, contours noirs épais,
 * ombres dures décalées, pastels vifs ; titres en Fredoka, texte en Space Grotesk.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        cream: '#FFFDF0',
        ink: '#111111',
        banana: '#FFD84D',
        mint: '#7BE0AD',
        coral: '#FF9478',
        sky: '#8FD3FF',
        peach: '#FFC9A8',
        lilac: '#C3A6FF',
      },
      fontFamily: {
        display: ['Fredoka', 'system-ui', 'sans-serif'],
        sans: ['Space Grotesk', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'pop-sm': '2px 2px 0 #000',
        pop: '4px 4px 0 #000',
        'pop-lg': '6px 6px 0 #000',
      },
      borderWidth: { 3: '3px' },
      keyframes: {
        confetti: {
          '0%': { transform: 'translate(0,0) rotate(0) scale(1)', opacity: '1' },
          '100%': {
            transform: 'translate(var(--dx), var(--dy)) rotate(var(--rot)) scale(0.6)',
            opacity: '0',
          },
        },
        toast: {
          '0%': { transform: 'translateY(-16px) rotate(-3deg) scale(0.9)', opacity: '0' },
          '60%': { transform: 'translateY(2px) rotate(1deg) scale(1.03)', opacity: '1' },
          '100%': { transform: 'translateY(0) rotate(0) scale(1)', opacity: '1' },
        },
        pop: {
          '0%': { transform: 'scale(0.4) rotate(-12deg)', opacity: '0' },
          '70%': { transform: 'scale(1.12) rotate(3deg)', opacity: '1' },
          '100%': { transform: 'scale(1) rotate(-3deg)', opacity: '1' },
        },
      },
      animation: {
        confetti: 'confetti 1.1s cubic-bezier(0.2, 0.7, 0.3, 1) forwards',
        toast: 'toast 0.35s ease-out',
        pop: 'pop 0.45s ease-out both',
      },
    },
  },
  plugins: [],
};

export default config;
