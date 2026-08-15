/**
 * Getting the operator's attention when the tab is not in front of them.
 *
 * Three mechanisms, in descending order of how often they actually work:
 *
 *   1. Title flash and a favicon badge. Works everywhere, needs no permission,
 *      survives a backgrounded tab. This is the fallback that always fires.
 *   2. Web Notifications. Needs permission, granted from a user gesture.
 *   3. Service-worker notifications. The only path that works on Android Chrome
 *      reliably, and on iOS Safari the *only* path at all — and there only when
 *      the app has been installed to the home screen (`display: standalone`).
 *      A plain iOS Safari tab silently gets nothing, which is why the settings
 *      panel says so rather than showing a toggle that does nothing.
 *
 * Sound deliberately is not one of them: a backgrounded tab has its audio
 * suspended and its timers throttled, so "play a sound on new message" cannot
 * fire when it matters most. See sound.ts.
 */
import type { Prefs } from './store.js';

export interface NotifyInput {
  title: string;
  body: string;
  /** Collapses repeats: a second message in a channel replaces the first. */
  tag: string;
  channelId: string | null;
  /** Bypasses do-not-disturb. Used for approvals, which block an agent. */
  urgent?: boolean;
}

/* ── Title flash and favicon badge ───────────────────────────────────────── */

const BASE_TITLE = document.title;
let pending = 0;
let flashTimer: ReturnType<typeof setInterval> | null = null;
let flashOn = false;

function renderTitle(): void {
  if (pending === 0) {
    document.title = BASE_TITLE;
    return;
  }
  document.title = flashOn ? `(${pending}) ${BASE_TITLE}` : `${BASE_TITLE}`;
}

/**
 * The favicon, drawn at runtime.
 *
 * A canvas rather than two checked-in .ico files: the badge count has to be on
 * it, and rendering it here means the unread number is visible in the tab strip
 * even when the title is truncated to six characters, which is what happens as
 * soon as the operator has a few tabs open.
 */
function paintFavicon(count: number): void {
  try {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, '#6e8bff');
    gradient.addColorStop(1, '#b58bff');
    ctx.fillStyle = gradient;
    roundRect(ctx, 4, 4, size - 8, size - 8, 14);
    ctx.fill();

    ctx.fillStyle = '#0a0e1c';
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('H', size / 2, size / 2 + 2);

    if (count > 0) {
      ctx.fillStyle = '#ff5f6d';
      ctx.beginPath();
      ctx.arc(size - 16, 16, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 20px system-ui, sans-serif';
      ctx.fillText(count > 9 ? '9+' : String(count), size - 16, 17);
    }

    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = 'image/png';
    link.href = canvas.toDataURL('image/png');
  } catch {
    /* a tab icon is never worth an exception */
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function bumpBadge(): void {
  pending += 1;
  paintFavicon(pending);
  if (!flashTimer) {
    flashTimer = setInterval(() => {
      flashOn = !flashOn;
      renderTitle();
    }, 1_100);
  }
  renderTitle();
}

/** Called when the operator comes back to the tab. */
export function clearBadge(): void {
  pending = 0;
  flashOn = false;
  if (flashTimer) {
    clearInterval(flashTimer);
    flashTimer = null;
  }
  renderTitle();
  paintFavicon(0);
}

/* ── Permission and delivery ─────────────────────────────────────────────── */

export type NotifySupport =
  | 'granted'
  | 'denied'
  | 'default'
  | 'unsupported'
  /** iOS Safari in a plain tab: the API exists but never delivers. */
  | 'needs-install';

export function notifySupport(): NotifySupport {
  if (typeof Notification === 'undefined') {
    return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
  }
  if (isIos() && !isStandalone()) return 'needs-install';
  return Notification.permission as NotifySupport;
}

function isIos(): boolean {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS reports as a Mac; the touch points give it away.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** Must be called from a user gesture or browsers reject it out of hand. */
export async function requestNotificationPermission(): Promise<NotifySupport> {
  if (typeof Notification === 'undefined') return notifySupport();
  try {
    return (await Notification.requestPermission()) as NotifySupport;
  } catch {
    return 'denied';
  }
}

let swRegistration: ServiceWorkerRegistration | null = null;

/**
 * Register the service worker.
 *
 * It exists for notification delivery and click routing, not for offline
 * caching: the dashboard is a live view of a fleet, and a stale cached shell
 * showing yesterday's agents would be worse than a failed load.
 */
export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js');
  } catch {
    // Registration fails on http:// origins other than localhost. The title
    // flash still works, so this is a downgrade rather than a failure.
  }
}

export function notifyMessage(input: NotifyInput, prefs: Prefs): void {
  if (document.visibilityState !== 'visible') bumpBadge();

  const suppressed = prefs.doNotDisturb && !input.urgent;
  if (suppressed || !prefs.notifications) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  const options: NotificationOptions & { data?: unknown } = {
    body: input.body,
    tag: input.tag,
    // A message arriving while the operator is mid-sentence elsewhere should
    // not steal focus with a sound the OS picked; approvals are the exception.
    silent: !input.urgent,
    data: { channelId: input.channelId, url: location.origin },
  };

  // The service worker path is the one that works on Android and on installed
  // iOS; the constructor is the desktop fallback.
  if (swRegistration) {
    void swRegistration.showNotification(input.title, options).catch(() => {
      new Notification(input.title, options);
    });
    return;
  }
  try {
    new Notification(input.title, options);
  } catch {
    /* some browsers throw for constructor notifications; the badge still fired */
  }
}

/** Repaint the badge on load so a reload does not leave a stale count. */
export function installBadge(): () => void {
  paintFavicon(0);
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') clearBadge();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onVisible);
  };
}
