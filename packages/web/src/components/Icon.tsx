import type { JSX } from 'react';

/**
 * Inline stroke icons on a 24×24 grid.
 *
 * Drawn rather than pulled from an icon font or emoji: emoji render differently
 * per platform and read as decoration, while a consistent 1.75px stroke set
 * reads as interface. Everything inherits `currentColor` so a single CSS colour
 * drives the whole set.
 */

export type IconName =
  | 'chat'
  | 'activity'
  | 'scale'
  | 'folder'
  | 'shield'
  | 'hash'
  | 'megaphone'
  | 'brain'
  | 'thread'
  | 'wrench'
  | 'at'
  | 'plus'
  | 'send'
  | 'paperclip'
  | 'close'
  | 'check'
  | 'ban'
  | 'pause'
  | 'play'
  | 'stop'
  | 'refresh'
  | 'download'
  | 'upload'
  | 'clock'
  | 'alert'
  | 'cpu'
  | 'users'
  | 'menu'
  | 'archive'
  | 'trash'
  | 'edit'
  | 'bell'
  | 'bell-off'
  | 'volume'
  | 'volume-off'
  | 'gauge'
  | 'chevron'
  | 'more'
  | 'moon'
  | 'settings'
  | 'arrow-down'
  | 'undo';

const PATHS: Record<IconName, JSX.Element> = {
  chat: <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.8-.8L3 21l1.9-5.1A8.4 8.4 0 0 1 4 11.5a8.5 8.5 0 0 1 8.5-8.4A8.4 8.4 0 0 1 21 11.5Z" />,
  activity: (
    <>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </>
  ),
  scale: (
    <>
      <path d="M12 3v18M7 21h10M6 7l-3 7h6L6 7ZM18 7l-3 7h6l-3-7ZM3 7h18" />
    </>
  ),
  folder: <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4.6a2 2 0 0 1 1.6.8l1 1.4a2 2 0 0 0 1.6.8H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z" />,
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />,
  hash: <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />,
  megaphone: <path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1ZM16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14" />,
  brain: <path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 1 5 3 3 0 0 0 4 3V4ZM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-1 5 3 3 0 0 1-4 3V4Z" />,
  thread: <path d="M4 5h16M4 10h10M4 15h13M4 20h7" />,
  wrench: <path d="M14.7 6.3a4 4 0 0 0 5 5.2l-9 9a2.8 2.8 0 0 1-4-4l9-9a4 4 0 0 0-1-1.2Z" />,
  at: <path d="M16 12a4 4 0 1 1-4-4M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.6 7.2" />,
  plus: <path d="M12 5v14M5 12h14" />,
  send: <path d="m22 2-7 20-4-9-9-4Zm0 0L11 13" />,
  paperclip: <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8.5-8.6a3.4 3.4 0 0 1 4.8 4.8L10.2 17.8a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  check: <path d="m20 6-11 11-5-5" />,
  ban: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8" />,
  pause: <path d="M10 4v16M16 4v16" />,
  play: <path d="m6 4 14 8-14 8V4Z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  refresh: <path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" />,
  download: <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />,
  upload: <path d="M12 21V9m0 0 4 4m-4-4-4 4M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2" />,
  clock: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2" />,
  alert: <path d="M12 3 2 20h20L12 3ZM12 10v4M12 17.5v.5" />,
  cpu: <path d="M6 6h12v12H6zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />,
  users: <path d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 20v-2a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8" />,
  menu: <path d="M3 6h18M3 12h18M3 18h18" />,
  archive: <path d="M3 4h18v4H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />,
  trash: <path d="M4 7h16M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6" />,
  edit: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />,
  bell: <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M13.7 21a2 2 0 0 1-3.4 0" />,
  'bell-off': <path d="M18.6 13A17 17 0 0 1 18 8M8.7 3.7A6 6 0 0 1 18 8M6 8a6 6 0 0 0-.3 1.9C5.5 15 3 16 3 16h13M13.7 21a2 2 0 0 1-3.4 0M2 2l20 20" />,
  volume: <path d="M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />,
  'volume-off': <path d="M11 5 6 9H2v6h4l5 4V5ZM22 9l-6 6M16 9l6 6" />,
  gauge: <path d="M12 21a9 9 0 1 1 9-9M12 12l5-3M3.5 15h3M17.5 15h3" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  more: <path d="M12 6.01V6M12 12.01V12M12 18.01V18" />,
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />,
  settings: (
    <>
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-3-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.3 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  'arrow-down': <path d="M12 4v14m0 0 6-6m-6 6-6-6" />,
  undo: <path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />,
};

export function Icon({
  name,
  size = 20,
  strokeWidth = 1.75,
  className,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
