export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function clockSeconds(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Chat-style stamp: time for today, date otherwise. */
export function stamp(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  const sameDay =
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const wasYesterday =
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear();

  if (sameDay) return `Today at ${clock(ts)}`;
  if (wasYesterday) return `Yesterday at ${clock(ts)}`;
  return `${date.toLocaleDateString()} ${clock(ts)}`;
}

export function relative(ts: number): string {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

export function initials(name: string): string {
  const parts = name.split(/[\s:_.-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '?').slice(0, 2).toUpperCase();
  return `${(parts[0] ?? '')[0] ?? ''}${(parts[1] ?? '')[0] ?? ''}`.toUpperCase();
}

/**
 * Deterministic avatar colour from a name, so an agent keeps the same colour
 * across reloads and machines without storing anything.
 */
const AVATAR_COLORS = [
  '#5eb1ff',
  '#54d18c',
  '#f5c14b',
  '#ff7a7f',
  '#b98bff',
  '#4fd6d0',
  '#ffa057',
  '#87d05a',
];

export function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? '#5eb1ff';
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
