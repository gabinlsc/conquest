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
    },
  },
  plugins: [],
};

export default config;
