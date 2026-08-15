import { useEffect, useState } from 'react';
import {
  isStandalone,
  notifySupport,
  requestNotificationPermission,
  type NotifySupport,
} from '../notify.js';
import { preview, unlockAudio } from '../sound.js';
import { useHive } from '../store.js';
import { Icon } from './Icon.js';

/**
 * Sound and notification settings.
 *
 * This panel tells the truth about what the current browser can actually do
 * rather than showing four toggles and hoping. In particular an iOS Safari tab
 * that has not been installed to the home screen cannot receive notifications
 * at all — no error, no prompt, nothing — so it gets an explanation and an
 * install instruction instead of a switch that silently does nothing.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const prefs = useHive((s) => s.prefs);
  const setPrefs = useHive((s) => s.setPrefs);
  const channels = useHive((s) => s.channels);
  const toggleMute = useHive((s) => s.toggleMute);
  const [support, setSupport] = useState<NotifySupport>(() => notifySupport());

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const enableNotifications = async (): Promise<void> => {
    const result = await requestNotificationPermission();
    setSupport(result);
    setPrefs({ notifications: result === 'granted' });
  };

  const muted = prefs.mutedChannels
    .map((id) => channels[id])
    .filter((c): c is NonNullable<typeof c> => Boolean(c));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row">
          <h3>Alerts</h3>
          <span className="spacer" />
          <button className="bare" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>

        <Toggle
          icon={prefs.sound ? 'volume' : 'volume-off'}
          label="Sound"
          hint="A short blip on new messages, a brighter one when you are mentioned."
          checked={prefs.sound}
          onChange={(value) => {
            // Flipping the switch is itself the user gesture that unlocks audio,
            // so this is the one reliable moment to arm it.
            unlockAudio();
            setPrefs({ sound: value });
            if (value) preview('message');
          }}
        />

        {prefs.sound && (
          <div className="preview-row">
            <span className="muted">Preview</span>
            <button className="tiny ghost" onClick={() => preview('message')}>
              Message
            </button>
            <button className="tiny ghost" onClick={() => preview('mention')}>
              Mention
            </button>
            <button className="tiny ghost" onClick={() => preview('approval')}>
              Approval
            </button>
          </div>
        )}

        <Toggle
          icon={prefs.doNotDisturb ? 'moon' : 'bell'}
          label="Do not disturb"
          hint="Silences sound and notifications. Approvals still come through — something is blocked on you."
          checked={prefs.doNotDisturb}
          onChange={(value) => setPrefs({ doNotDisturb: value })}
        />

        <div className="setting">
          <div className="setting-main">
            <Icon name={prefs.notifications ? 'bell' : 'bell-off'} size={17} className="muted" />
            <div>
              <div className="setting-label">Notifications</div>
              <div className="hint">{describeSupport(support)}</div>
            </div>
          </div>
          {support === 'granted' ? (
            <Switch
              checked={prefs.notifications}
              onChange={(value) => setPrefs({ notifications: value })}
              label="Notifications"
            />
          ) : support === 'default' ? (
            <button className="tiny primary" onClick={() => void enableNotifications()}>
              Enable
            </button>
          ) : null}
        </div>

        {support === 'needs-install' && !isStandalone() && (
          <div className="callout">
            <strong>Install to get notifications on iPhone.</strong> Tap the share button, then
            &ldquo;Add to Home Screen&rdquo;. Safari only delivers notifications to an installed
            app; a browser tab gets nothing, silently.
          </div>
        )}

        <div className="callout subtle">
          A backgrounded tab has its audio suspended and its timers throttled by the browser, so
          sound cannot fire while you are away from the page. The tab title and its icon still show
          the unread count, and notifications still arrive if you have them on.
        </div>

        {muted.length > 0 && (
          <div className="field">
            <label>Muted channels</label>
            <div className="chips">
              {muted.map((channel) => (
                <button key={channel.id} className="chip" onClick={() => toggleMute(channel.id)}>
                  #{channel.name}
                  <Icon name="close" size={12} />
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function describeSupport(support: NotifySupport): string {
  switch (support) {
    case 'granted':
      return 'Allowed by this browser. Delivered when the tab is not in front of you.';
    case 'denied':
      return 'Blocked in your browser settings for this site. Re-allow it there to turn this on.';
    case 'default':
      return 'Not asked yet. Enabling opens the browser permission prompt.';
    case 'needs-install':
      return 'Not available in an iOS browser tab — install the app to the home screen first.';
    default:
      return 'This browser does not support notifications.';
  }
}

function Toggle({
  icon,
  label,
  hint,
  checked,
  onChange,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}): JSX.Element {
  return (
    <div className="setting">
      <div className="setting-main">
        <Icon name={icon} size={17} className="muted" />
        <div>
          <div className="setting-label">{label}</div>
          <div className="hint">{hint}</div>
        </div>
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}): JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" />
    </button>
  );
}
