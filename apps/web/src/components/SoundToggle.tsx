'use client';

import { Volume2, VolumeX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isMuted, onMuteChange, setMuted, sfx, unlockAudio } from '@/lib/sound';

export function SoundToggle() {
  const [muted, setLocal] = useState(false);
  useEffect(() => {
    setLocal(isMuted());
    return onMuteChange(() => setLocal(isMuted()));
  }, []);
  return (
    <button
      className="btn !px-3"
      aria-label={muted ? 'Activer le son' : 'Couper le son'}
      title={muted ? 'Activer le son' : 'Couper le son'}
      onClick={() => {
        const next = !muted;
        setMuted(next);
        if (!next) {
          unlockAudio();
          sfx.hit(0);
        }
      }}
    >
      {muted ? (
        <VolumeX className="h-4 w-4" strokeWidth={3} />
      ) : (
        <Volume2 className="h-4 w-4" strokeWidth={3} />
      )}
    </button>
  );
}
