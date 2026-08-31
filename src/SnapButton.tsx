/**
 * "Capture area" for a comment: choose an area of the page, grab it as a PNG,
 * upload it and hand the URL back to the form as an image attachment.
 */
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { uploadImage } from './api.js';
import { captureRegion, selectRegion } from './recorder.js';

type Phase = 'idle' | 'selecting' | 'capturing';

export function SnapButton({
  onDone,
  onBusy,
  style,
}: {
  onDone: (url: string) => void;
  onBusy?: (busy: boolean) => void;
  style?: CSSProperties;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(onBusy);
  busyRef.current = onBusy;
  useEffect(() => {
    busyRef.current?.(phase !== 'idle');
  }, [phase]);

  const begin = async () => {
    setError(null);
    setPhase('selecting');
    const rect = await selectRegion();
    if (!rect) {
      setPhase('idle');
      return;
    }
    setPhase('capturing');
    try {
      const blob = await captureRegion(rect);
      const file = new File([blob], 'capture.png', { type: 'image/png' });
      onDone(await uploadImage(file));
    } catch (e) {
      setError(
        e instanceof Error && e.name === 'NotAllowedError'
          ? 'Screen capture was cancelled.'
          : 'Screen capture is not available in this browser.',
      );
    } finally {
      setPhase('idle');
    }
  };

  return (
    <>
      <button
        type="button"
        style={style}
        disabled={phase !== 'idle'}
        onClick={() => void begin()}
        title="Capture part of the screen and attach it as an image"
      >
        {phase === 'capturing' ? 'Capturing…' : 'Capture area'}
      </button>
      {error && <span style={{ fontSize: 11.5, color: '#b3261e' }}>{error}</span>}
    </>
  );
}
