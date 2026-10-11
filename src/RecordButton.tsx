/**
 * "Record screen" for a comment: choose an area, record it, stop whenever, and
 * hand the uploaded clip's URL back to the form. While recording the page is
 * live (the toolbar steps aside through onBusy), the chosen area is framed, and a
 * bar kept clear of that area shows the time and the Stop button.
 */
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApi } from './api.js';
import { reportError } from './events.js';
import { TOOLBAR_ATTR } from './anchors.js';
import { RecordIcon, StopIcon } from './icons.js';
import { HIGHLIGHT, type Recording, type Rect, selectRegion, startRecording } from './recorder.js';

type Phase = 'idle' | 'selecting' | 'recording' | 'uploading';

const fmt = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export function RecordButton({
  onDone,
  onBusy,
  style,
  className,
  iconSize = 14,
}: {
  onDone: (url: string) => void;
  /** Called with true while selecting, recording or saving, so the toolbar can step aside. */
  onBusy?: (busy: boolean) => void;
  style?: CSSProperties;
  className?: string;
  iconSize?: number;
}) {
  const { uploadVideo } = useApi();
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** The recorded area when the clip is cropped to it; null when the whole capture is kept. */
  const [area, setArea] = useState<Rect | null>(null);
  const rec = useRef<Recording | null>(null);
  const busyRef = useRef(onBusy);
  busyRef.current = onBusy;

  useEffect(() => {
    busyRef.current?.(phase !== 'idle');
  }, [phase]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const t = window.setInterval(
      () => setElapsed(Math.round((Date.now() - (rec.current?.startedAt ?? Date.now())) / 1000)),
      500,
    );
    return () => window.clearInterval(t);
  }, [phase]);

  const finish = async () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    setPhase('uploading');
    try {
      const blob = await r.stop();
      if (blob.size === 0) throw new Error('empty');
      onDone(await uploadVideo(blob));
    } catch (e) {
      reportError('record', e, { during: 'save recording' });
      setError('Saving the recording failed.');
    } finally {
      setArea(null);
      setPhase('idle');
    }
  };

  const begin = async () => {
    setError(null);
    setPhase('selecting');
    const rect = await selectRegion();
    if (!rect) {
      setPhase('idle');
      return;
    }
    try {
      const r = await startRecording(rect);
      rec.current = r;
      r.onEnded(() => void finish());
      setArea(r.cropped ? rect : null);
      setElapsed(0);
      setPhase('recording');
    } catch (e) {
      if (!(e instanceof Error && e.name === 'NotAllowedError')) reportError('record', e, { during: 'start recording' });
      setError(
        e instanceof Error && e.name === 'NotAllowedError'
          ? 'Screen capture was cancelled.'
          : 'Screen recording is not available in this browser.',
      );
      setPhase('idle');
    }
  };

  const hud =
    phase === 'recording' || phase === 'uploading'
      ? createPortal(
          <div {...{ [TOOLBAR_ATTR]: '' }}>
            <RecordingHud
              area={area}
              elapsed={elapsed}
              saving={phase === 'uploading'}
              onStop={() => void finish()}
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
        title="Record screen: drag out an area, use the page as usual, stop from the bar at the top; the clip is attached here"
        aria-label="Record screen"
      >
        <RecordIcon size={iconSize} />
      </button>
      {error && <span style={{ fontSize: 11.5, color: '#b3261e' }}>{error}</span>}
      {hud}
    </>
  );
}

/** The frame around the recorded area and the bar with the clock and Stop. */
function RecordingHud({
  area,
  elapsed,
  saving,
  onStop,
}: {
  area: Rect | null;
  elapsed: number;
  saving: boolean;
  onStop: () => void;
}) {
  // The bar sits above the recorded area when there is room, below it otherwise,
  // so it stays out of the clip; a full-page recording gets it at the top.
  const atTop = !area || area.y >= 64 || area.y + area.h > window.innerHeight - 64;
  return (
    <>
      <style>{'@keyframes rt-rec{0%,100%{opacity:1}50%{opacity:.25}}'}</style>
      {area && (
        <div
          data-rt-rec-frame
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
        data-rt-rec-bar
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
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: '#e5484d',
            boxShadow: '0 0 0 4px rgba(229,72,77,.3)',
            animation: saving ? undefined : 'rt-rec 1.2s ease-in-out infinite',
            flex: 'none',
          }}
        />
        {saving ? (
          <span>Saving the clip…</span>
        ) : (
          <>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>Recording {fmt(elapsed)}</span>
            <span style={{ fontWeight: 500, color: '#c9c6d6' }}>
              The page is live, click and scroll as usual.
            </span>
            <button
              type="button"
              onClick={onStop}
              style={{
                border: 'none',
                borderRadius: 999,
                background: '#fff',
                color: '#1b1926',
                padding: '7px 14px 7px 11px',
                fontWeight: 700,
                cursor: 'pointer',
                font: 'inherit',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <StopIcon size={13} />
              Stop &amp; attach to comment
            </button>
          </>
        )}
      </div>
    </>
  );
}
