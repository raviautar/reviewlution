/**
 * "Capture area" for a comment: choose an area of the page, grab it as a PNG,
 * upload it and hand the URL back to the form as an image attachment.
 */
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { uploadImage } from './api.js';
import { CameraIcon } from './icons.js';
import { capturePage, captureRegion, displayCaptureSupported, selectRegion } from './recorder.js';

type Phase = 'idle' | 'selecting' | 'capturing';

export function SnapButton({
  onDone,
  onBusy,
  style,
  className,
  iconSize = 14,
}: {
  onDone: (url: string) => void;
  /** Called with true while an area is picked or captured, so the shell can step aside. */
  onBusy?: (busy: boolean) => void;
  style?: CSSProperties;
  className?: string;
  iconSize?: number;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(onBusy);
  busyRef.current = onBusy;
  useEffect(() => {
    busyRef.current?.(phase !== 'idle');
  }, [phase]);

  const native = displayCaptureSupported();

  const begin = async () => {
    setError(null);
    if (!native) {
      // One tap on a phone: the page as it stands, straight into the comment.
      setPhase('capturing');
      try {
        const blob = await capturePage();
        const file = new File([blob], 'capture.png', { type: 'image/png' });
        onDone(await uploadImage(file));
      } catch {
        setError('Could not capture the page.');
      } finally {
        setPhase('idle');
      }
      return;
    }
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
        className={className}
        style={{ ...style, opacity: phase === 'idle' ? undefined : 0.5 }}
        disabled={phase !== 'idle'}
        onClick={() => void begin()}
        title={
          native
            ? 'Capture area: drag out part of the page, it is attached as an image'
            : 'Capture the screen: the page as you see it is attached as an image'
        }
        aria-label="Capture area"
      >
        <CameraIcon size={iconSize} />
      </button>
      {error && <span style={{ fontSize: 11.5, color: '#b3261e' }}>{error}</span>}
    </>
  );
}
