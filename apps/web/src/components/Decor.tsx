/** Formes décoratives façon autocollants (étoile, éclair, ondulation…), clin d'œil à glsc.fr. */
const stroke = {
  stroke: '#111',
  strokeWidth: 4,
  strokeLinejoin: 'round' as const,
  strokeLinecap: 'round' as const,
};

export function Star({ className = '', fill = '#FFD84D' }: { className?: string; fill?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={`pointer-events-none ${className}`} aria-hidden>
      <path
        d="M50 6 L62 38 L96 40 L69 61 L78 94 L50 75 L22 94 L31 61 L4 40 L38 38 Z"
        fill={fill}
        {...stroke}
      />
    </svg>
  );
}

export function Spark({ className = '', fill = '#8FD3FF' }: { className?: string; fill?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={`pointer-events-none ${className}`} aria-hidden>
      <path
        d="M50 4 C54 34 66 46 96 50 C66 54 54 66 50 96 C46 66 34 54 4 50 C34 46 46 34 50 4 Z"
        fill={fill}
        {...stroke}
      />
    </svg>
  );
}

export function Squiggle({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 40" className={`pointer-events-none ${className}`} aria-hidden>
      <path
        d="M4 20 C16 2 28 2 40 20 S64 38 76 20 S100 2 116 20"
        fill="none"
        stroke="#FF9478"
        strokeWidth={6}
        strokeLinecap="round"
      />
      <path
        d="M4 20 C16 2 28 2 40 20 S64 38 76 20 S100 2 116 20"
        fill="none"
        stroke="#111"
        strokeWidth={2}
        strokeLinecap="round"
        transform="translate(0 0)"
      />
    </svg>
  );
}

export function Blob({ className = '', fill = '#C3A6FF' }: { className?: string; fill?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={`pointer-events-none ${className}`} aria-hidden>
      <circle cx="50" cy="50" r="44" fill={fill} {...stroke} />
    </svg>
  );
}
