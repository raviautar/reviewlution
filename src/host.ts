/**
 * Where the reviewed app lives. The iframe shell reads it from its same-origin
 * frame; the in-page component is drawn over the app's own document. Every
 * component reads the page through this, never through `document` directly.
 */
import { createContext, useContext } from 'react';

export interface Host {
  /** The app's document, or null while it is not loaded. */
  doc: () => Document | null;
  /** The app's window: viewport size, scrolling, the phone capture. */
  win: () => Window | null;
}

/** The toolbar drawn over the document it runs in. */
export const pageHost: Host = {
  doc: () => (typeof document === 'undefined' ? null : document),
  win: () => (typeof window === 'undefined' ? null : window),
};

export const HostContext = createContext<Host>(pageHost);

export function useHost(): Host {
  return useContext(HostContext);
}
