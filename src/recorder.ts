/**
 * Screen recording for a comment. The reviewer drags a rectangle over the page,
 * the tab is captured with getDisplayMedia and cropped to that rectangle on a
 * canvas, and a MediaRecorder turns the frames into a webm clip. Cropping needs
 * the capture to be this tab (Chrome offers it first through preferCurrentTab);
 * a window or whole-screen capture is recorded as is.
 */

import { TOOLBAR_ATTR } from './anchors.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const HIGHLIGHT = '#ff1fb3';

export function displayCaptureSupported(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

/**
 * Phones have no getDisplayMedia, so the whole visible page is rasterized from
 * the app's document instead. In the iframe shell the toolbar lives in the
 * parent document, out of the shot by construction; drawn over the page it
 * shares the document, so its nodes (TOOLBAR_ATTR) are filtered out.
 */
export async function capturePage(win: Window | null): Promise<Blob> {
  const doc = win?.document;
  if (!win || !doc) throw new Error('no app document to capture');
  const { domToBlob } = await import('modern-screenshot');
  const blob = await domToBlob(doc.documentElement, {
    width: win.innerWidth,
    height: win.innerHeight,
    scale: Math.min(2, win.devicePixelRatio || 1),
    backgroundColor: getComputedStyle(doc.body).backgroundColor,
    style: { transform: `translate(${-win.scrollX}px, ${-win.scrollY}px)`, transformOrigin: 'top left' },
    filter: (node) => !(node instanceof Element && node.hasAttribute(TOOLBAR_ATTR)),
  });
  if (!blob || blob.size === 0) throw new Error('capture produced nothing');
  return blob;
}

function norm(a: { x: number; y: number }, e: MouseEvent): Rect {
  return {
    x: Math.min(a.x, e.clientX),
    y: Math.min(a.y, e.clientY),
    w: Math.abs(e.clientX - a.x),
    h: Math.abs(e.clientY - a.y),
  };
}

/** Let the reviewer drag out the area to record. A plain click means the whole viewport; Escape cancels. */
export function selectRegion(): Promise<Rect | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.setAttribute(TOOLBAR_ATTR, '');
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483000',
      cursor: 'crosshair',
      background: 'rgba(20,20,30,.28)',
    });
    const hint = document.createElement('div');
    hint.textContent = 'Drag to choose the area to record · click for the whole page · Esc to cancel';
    Object.assign(hint.style, {
      position: 'absolute',
      top: '18px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '8px 14px',
      borderRadius: '10px',
      background: '#1b1926',
      color: '#fff',
      font: '600 12.5px system-ui, sans-serif',
      pointerEvents: 'none',
      whiteSpace: 'nowrap',
    });
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'absolute',
      display: 'none',
      border: `2px solid ${HIGHLIGHT}`,
      boxShadow: '0 0 0 9999px rgba(20,20,30,.28)',
      pointerEvents: 'none',
    });
    overlay.append(hint, box);
    document.body.append(overlay);

    let start: { x: number; y: number } | null = null;
    const finish = (r: Rect | null) => {
      overlay.remove();
      window.removeEventListener('keydown', onKey);
      resolve(r);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(null);
    };
    window.addEventListener('keydown', onKey);
    const update = (e: MouseEvent) => {
      if (!start) return;
      const r = norm(start, e);
      Object.assign(box.style, {
        left: `${r.x}px`,
        top: `${r.y}px`,
        width: `${r.w}px`,
        height: `${r.h}px`,
      });
    };
    overlay.addEventListener('mousedown', (e) => {
      start = { x: e.clientX, y: e.clientY };
      overlay.style.background = 'transparent';
      box.style.display = 'block';
      update(e);
    });
    overlay.addEventListener('mousemove', update);
    overlay.addEventListener('mouseup', (e) => {
      if (!start) return;
      const r = norm(start, e);
      finish(r.w < 24 || r.h < 24 ? { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight } : r);
    });
  });
}

export interface Recording {
  startedAt: number;
  /** True when the capture is this tab and the clip is cropped to the chosen area. */
  cropped: boolean;
  stop: () => Promise<Blob>;
  /** Fires when the browser's own "Stop sharing" ends the capture. */
  onEnded: (cb: () => void) => void;
}

export async function startRecording(rect: Rect): Promise<Recording> {
  const constraints = {
    video: { frameRate: 30 },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'exclude',
  };
  const stream = await navigator.mediaDevices.getDisplayMedia(constraints as DisplayMediaStreamOptions);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('no video track');
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  if (!video.videoWidth)
    await new Promise<void>((r) => video.addEventListener('loadedmetadata', () => r(), { once: true }));

  const surface = (track.getSettings() as MediaTrackSettings & { displaySurface?: string })
    .displaySurface;
  const cropped = surface === 'browser';
  const sx = video.videoWidth / window.innerWidth;
  const sy = video.videoHeight / window.innerHeight;
  const crop = cropped
    ? { x: rect.x * sx, y: rect.y * sy, w: rect.w * sx, h: rect.h * sy }
    : { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight };
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(crop.w));
  canvas.height = Math.max(2, Math.round(crop.h));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');

  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) =>
    MediaRecorder.isTypeSupported(m),
  );
  const recorder = new MediaRecorder(
    canvas.captureStream(30),
    mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined,
  );
  const chunks: Blob[] = [];
  recorder.addEventListener('dataavailable', (e) => {
    if (e.data.size) chunks.push(e.data);
  });
  let raf = 0;
  const draw = () => {
    ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
    raf = requestAnimationFrame(draw);
  };
  draw();
  recorder.start(1000);

  let done: Promise<Blob> | null = null;
  const stop = () => {
    done ??= new Promise<Blob>((resolve) => {
      const settle = () => {
        cancelAnimationFrame(raf);
        for (const t of stream.getTracks()) t.stop();
        resolve(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }));
      };
      if (recorder.state === 'inactive') settle();
      else {
        recorder.addEventListener('stop', settle, { once: true });
        recorder.stop();
      }
    });
    return done;
  };
  const endedCbs: (() => void)[] = [];
  track.addEventListener('ended', () => {
    for (const cb of endedCbs) cb();
  });
  return { startedAt: Date.now(), cropped, stop, onEnded: (cb) => endedCbs.push(cb) };
}

/**
 * Arm a still capture of the chosen area. The tab is captured and kept live so
 * the reviewer can set the page up — re-open a dropdown a click had closed —
 * before `grab()` takes the frame; `cancel()` drops the capture untaken. This
 * two-step shape is what lets a capture include an open menu: nothing is
 * clicked at the moment the frame is taken.
 */
export interface ArmedCapture {
  /** True when the capture is this tab and the frame is cropped to the chosen area. */
  cropped: boolean;
  grab: () => Promise<Blob>;
  cancel: () => void;
}

export async function beginCapture(rect: Rect): Promise<ArmedCapture> {
  const constraints = {
    video: { frameRate: 5 },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'exclude',
  };
  const stream = await navigator.mediaDevices.getDisplayMedia(constraints as DisplayMediaStreamOptions);
  const track = stream.getVideoTracks()[0];
  if (!track) {
    for (const t of stream.getTracks()) t.stop();
    throw new Error('no video track');
  }
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  if (!video.videoWidth)
    await new Promise<void>((r) =>
      video.addEventListener('loadedmetadata', () => r(), { once: true }),
    );
  const surface = (track.getSettings() as MediaTrackSettings & { displaySurface?: string })
    .displaySurface;
  const cropped = surface === 'browser';
  const cancel = () => {
    for (const t of stream.getTracks()) t.stop();
  };
  const grab = async (): Promise<Blob> => {
    try {
      // The frame is read against the live viewport size, so a page that
      // reflowed while the reviewer set it up still crops to the right box.
      const sx = video.videoWidth / window.innerWidth;
      const sy = video.videoHeight / window.innerHeight;
      const crop = cropped
        ? { x: rect.x * sx, y: rect.y * sy, w: rect.w * sx, h: rect.h * sy }
        : { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight };
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(2, Math.round(crop.w));
      canvas.height = Math.max(2, Math.round(crop.h));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no canvas');
      ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no image'))), 'image/png'),
      );
    } finally {
      cancel();
    }
  };
  return { cropped, grab, cancel };
}
