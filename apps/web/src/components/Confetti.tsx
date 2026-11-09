const COLORS = ['#FFD84D', '#7BE0AD', '#FF9478', '#8FD3FF', '#C3A6FF', '#FFC9A8'];

/** Explosion de confettis (CSS pur) ; masquée si l'utilisateur a demandé moins d'animations. */
export function Confetti({ count = 28 }: { count?: number }) {
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-visible motion-reduce:hidden"
      aria-hidden
    >
      {Array.from({ length: count }, (_, i) => {
        const angle = (i / count) * Math.PI * 2 + (i % 3) * 0.3;
        const dist = 110 + ((i * 53) % 130);
        return (
          <span
            key={i}
            className="absolute left-1/2 top-1/3 block animate-confetti border-2 border-ink"
            style={
              {
                width: 10 + (i % 3) * 4,
                height: 10 + ((i + 1) % 3) * 4,
                background: COLORS[i % COLORS.length],
                borderRadius: i % 2 ? '50%' : '3px',
                '--dx': `${Math.cos(angle) * dist}px`,
                '--dy': `${Math.sin(angle) * dist - 40}px`,
                '--rot': `${(i * 97) % 720}deg`,
                animationDelay: `${(i % 6) * 40}ms`,
              } as React.CSSProperties
            }
          />
        );
      })}
    </div>
  );
}
