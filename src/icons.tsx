/** Inline SVG icons for the toolbar and dialogs — no emoji glyphs. */

function Svg({ d, size = 15, fill = false }: { d: string; size?: number; fill?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ display: 'block' }}
    >
      <path d={d} />
    </svg>
  );
}

export function PencilIcon({ size }: { size?: number }) {
  return <Svg size={size} d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />;
}

export function ChatIcon({ size }: { size?: number }) {
  return <Svg size={size} d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />;
}

export function CloseIcon({ size }: { size?: number }) {
  return <Svg size={size} d="M18 6L6 18M6 6l12 12" />;
}

export function ImagePlusIcon({ size }: { size?: number }) {
  return (
    <Svg
      size={size}
      d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7M16 5h6M19 2v6M21 15l-5-5L5 21"
    />
  );
}

export function GripIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      style={{ display: 'block' }}
    >
      <circle cx="9" cy="5" r="1.7" />
      <circle cx="15" cy="5" r="1.7" />
      <circle cx="9" cy="12" r="1.7" />
      <circle cx="15" cy="12" r="1.7" />
      <circle cx="9" cy="19" r="1.7" />
      <circle cx="15" cy="19" r="1.7" />
    </svg>
  );
}
