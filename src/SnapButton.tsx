/**
 * "Capture area" for a comment: choose an area of the page, then a short live
 * countdown while the page stays interactive — so a dropdown a click had closed
 * can be re-opened before the frame is taken — grab it as a PNG, upload it, and
 * hand the URL back to the form. On a phone (no tab capture) it is one tap of
 * the page as it stands.
 */
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApi } from './api.js';
import { reportError } from './events.js';
import { TOOLBAR_ATTR } from './anchors.js';
import { useHost } from './host.js';
import { CameraIcon } from './icons.js';
import {
  type ArmedCapture,
  HIGHLIGHT,
  type Rect,
  beginCapture,
  capturePage,
  displayCaptureSupported,
  selectRegion,
} from './recorder.js';

type Phase = 'idle' | 'selecting' | 'arming' | 'countdown' | 'capturing';
/** Seconds the page stays live before the frame is taken automatically. */
const COUNTDOWN = 3;

export function SnapButton({
  onDone,
  onBusy,
  style,
  className,
  iconSize = 14,
}: {
  onDone: (url: string) => void;
  /** Called with true while an area is picked or captured, so the toolbar can step aside. */
  onBusy?: (busy: boolean) => void;
  style?: CSSProperties;
  className?: string;
  iconSize?: number;
}) {
  const { uploadImage } = useApi();
  const host = useHost();
  const [phase, setPhase] = useState<Phase>('idle');
  const [left, setLeft] = useState(COUNTDOWN);
  const [area, setArea] = useState<Rect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const armed = useRef<ArmedCapture | null>(null);
  const busyRef = useRef(onBusy);
  busyRef.current = onBusy;
  useEffect(() => {
    busyRef.current?.(phase !== 'idle');
  }, [phase]);

  const native = displayCaptureSupported();

  const take = async () => {
    const cap = armed.current;
    if (!cap) return;
    armed.current = null;
    setPhase('capturing');
    try {
      const blob = await cap.grab();
      const file = new File([blob], 'capture.png', { type: 'image/png' });
      onDone(await uploadImage(file));
    } catch (e) {
      reportError('capture', e, { during: 'save area capture' });
      setError('Saving the capture failed.');
    } finally {
      setArea(null);
      setPhase('idle');
    }
  };

  const cancel = () => {
    armed.current?.cancel();
    armed.current = null;
    setArea(null);
    setPhase('idle');
  };

  // Tick the countdown down; at zero the frame is taken with no click, so an
  // open menu is still open when it is grabbed.
  useEffect(() => {
    if (phase !== 'countdown') return;
    if (left <= 0) {
      void take();
      return;
    }
    const t = window.setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(t);
  }, [phase, left]);

  const begin = async () => {
    setError(null);
    if (!native) {
      // One tap on a phone: the page as it stands, straight into the comment.
      setPhase('capturing');
      try {
        const blob = await capturePage(host.win());
        const file = new File([blob], 'capture.png', { type: 'image/png' });
        onDone(await uploadImage(file));
      } catch (e) {
        reportError('capture', e, { during: 'capture page' });
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
    setPhase('arming');
    try {
      const cap = await beginCapture(rect);
      armed.current = cap;
      setArea(cap.cropped ? rect : null);
      setLeft(COUNTDOWN);
      setPhase('countdown');
    } catch (e) {
      if (!(e instanceof Error && e.name === 'NotAllowedError')) reportError('capture', e, { during: 'start screen capture' });
      setError(
        e instanceof Error && e.name === 'NotAllowedError'
          ? 'Screen capture was cancelled.'
          : 'Screen capture is not available in this browser.',
      );
      setPhase('idle');
    }
  };

  const hud =
    phase === 'countdown' || phase === 'capturing'
      ? createPortal(
          <div {...{ [TOOLBAR_ATTR]: '' }}>
            <CaptureHud
              area={area}
              left={left}
              capturing={phase === 'capturing'}
              onNow={() => void take()}
              onCancel={cancel}
            />
          </div>,
          document.body,
        )
      : null;

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
            ? 'Capture area: drag out a box, then re-open any menu before it snaps — the shot includes what is open'
            : 'Capture the screen: the page as you see it is attached as an image'
        }
        aria-label="Capture area"
      >
        <CameraIcon size={iconSize} />
      </button>
      {error && <span style={{ fontSize: 11.5, color: '#b3261e' }}>{error}</span>}
      {hud}
    </>
  );
}

/** The frame around the chosen area, and the bar with the countdown and controls. */
function CaptureHud({
  area,
  left,
  capturing,
  onNow,
  onCancel,
}: {
  area: Rect | null;
  left: number;
  capturing: boolean;
  onNow: () => void;
  onCancel: () => void;
}) {
  const atTop = !area || area.y >= 64 || area.y + area.h > window.innerHeight - 64;
  return (
    <>
      {area && (
        <div
          data-review-cap-frame
          style={{
            position: 'fixed',
            left: area.x - 3,
            top: area.y - 3,
            width: area.w + 6,
            height: area.h + 6,
            boxSizing: 'border-box',
            border: `3px solid ${HIGHLIGHT}`,
            borderRadius: 5,
            pointerEvents: 'none',
            zIndex: 2147483001,
          }}
        />
      )}
      <div
        role="status"
        data-review-cap-bar
        style={{
          position: 'fixed',
          left: '50%',
          ...(atTop ? { top: 14 } : { bottom: 14 }),
          transform: 'translateX(-50%)',
          zIndex: 2147483002,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          maxWidth: 'calc(100vw - 24px)',
          padding: '8px 8px 8px 16px',
          borderRadius: 999,
          background: '#1b1926',
          color: '#fff',
          boxShadow: `0 12px 34px -10px rgba(20,20,30,.65), 0 0 0 2px ${HIGHLIGHT}55`,
          font: '600 13px system-ui, sans-serif',
          whiteSpace: 'nowrap',
        }}
      >
        {capturing ? (
          <span>Saving the capture…</span>
        ) : (
          <>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              Capturing in {left}s — re-open any menu now
            </span>
            <button type="button" onClick={onNow} style={hudBtn}>
              Capture now
            </button>
            <button
              type="button"
              onClick={onCancel}
              style={{ ...hudBtn, background: 'transparent', color: '#c9c6d6' }}
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </>
  );
}

const hudBtn = {
  border: 'none',
  borderRadius: 999,
  background: '#fff',
  color: '#1b1926',
  padding: '7px 13px',
  fontWeight: 700,
  cursor: 'pointer',
  font: 'inherit',
} as const;
