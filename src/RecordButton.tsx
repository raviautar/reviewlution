/**
 * "Record screen" for a comment: choose an area, record it, stop whenever, and
 * hand the uploaded clip's URL back to the form. While recording, a small pill
 * at the bottom of the page shows the time and the Stop button.
 */
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { uploadVideo } from './api.js';
import { type Recording, selectRegion, startRecording } from './recorder.js';

type Phase = 'idle' | 'selecting' | 'recording' | 'uploading';

const fmt = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export function RecordButton({
  onDone,
  onBusy,
  style,
}: {
  onDone: (url: string) => void;
  /** Called with true while selecting, recording or saving, so the form can step aside. */
  onBusy?: (busy: boolean) => void;
  style?: CSSProperties;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
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
    } catch {
      setError('Saving the recording failed.');
    } finally {
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
      setElapsed(0);
      setPhase('recording');
    } catch (e) {
      setError(
        e instanceof Error && e.name === 'NotAllowedError'
          ? 'Screen capture was cancelled.'
          : 'Screen recording is not available in this browser.',
      );
      setPhase('idle');
    }
  };

  const hud =
    phase === 'recording'
      ? createPortal(
          <div
            style={{
              position: 'fixed',
              left: '50%',
              bottom: 22,
              transform: 'translateX(-50%)',
              zIndex: 2147483001,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '7px 8px 7px 14px',
              borderRadius: 999,
              background: '#1b1926',
              color: '#fff',
              boxShadow: '0 10px 30px -10px rgba(20,20,30,.6)',
              font: '600 12.5px system-ui, sans-serif',
            }}
          >
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: '50%',
                background: '#e5484d',
                boxShadow: '0 0 0 4px rgba(229,72,77,.3)',
              }}
            />
            Recording {fmt(elapsed)}
            <button
              type="button"
              onClick={() => void finish()}
              style={{
                border: 'none',
                borderRadius: 999,
                background: '#fff',
                color: '#1b1926',
                padding: '5px 12px',
                fontWeight: 700,
                cursor: 'pointer',
                font: 'inherit',
              }}
            >
              Stop
            </button>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        type="button"
        style={style}
        disabled={phase !== 'idle'}
        onClick={() => void begin()}
        title="Record part of the screen and attach the clip to this comment"
      >
        {phase === 'uploading' ? 'Saving clip…' : phase === 'recording' ? 'Recording…' : 'Record screen'}
      </button>
      {error && <span style={{ fontSize: 11.5, color: '#b3261e' }}>{error}</span>}
      {hud}
    </>
  );
}
