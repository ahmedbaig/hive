import type { Channel } from '@hive/shared';
import { useState } from 'react';
import { api, operatorName, setOperatorName } from '../api.js';
import { avatarColor, initials } from '../format.js';
import { useHive, visibleChannels } from '../store.js';
import { ChannelDialog } from './ChannelDialog.js';
import { Icon, type IconName } from './Icon.js';
import { SettingsDialog } from './SettingsDialog.js';

/** Fixed icon per channel so the list reads at a glance. */
export function channelIcon(channel: Channel): IconName {
  if (channel.kind === 'council') return 'scale';
  if (channel.kind === 'direct') return 'at';
  if (channel.kind === 'system') return 'megaphone';
  if (channel.name === 'memory') return 'brain';
  if (channel.name === 'sessions') return 'thread';
  if (channel.name === 'ops') return 'wrench';
  return 'hash';
}

/**
 * Channel list, on desktop a column and on mobile a drawer.
 *
 * The two are the same component rather than two layouts: a phone-only
 * navigation that drifts from the desktop one is how a channel ends up
 * archivable on one and not the other.
 */
export function Sidebar(): JSX.Element {
  const channels = useHive((s) => s.channels);
  const channelId = useHive((s) => s.channelId);
  const view = useHive((s) => s.view);
  const unread = useHive((s) => s.unread);
  const prefs = useHive((s) => s.prefs);
  const connection = useHive((s) => s.connection);
  const openChannel = useHive((s) => s.openChannel);
  const setPrefs = useHive((s) => s.setPrefs);
  const toast = useHive((s) => s.toast);

  const [editing, setEditing] = useState<Channel | null>(null);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * The open row menu, with the anchor's viewport position.
   *
   * Positioned `fixed` from a measured rect rather than `absolute` inside the
   * row: the channel list is a scroll container, and an absolutely positioned
   * menu on the last row is clipped by it — which is exactly the row whose menu
   * you reach for when you want to tidy up.
   */
  const [menu, setMenu] = useState<{ id: string; top: number; right: number; up: boolean } | null>(
    null,
  );
  const menuFor = menu?.id ?? null;

  const openMenu = (id: string, anchor: HTMLElement): void => {
    const rect = anchor.getBoundingClientRect();
    // Roughly the menu's own height; enough to decide which way to open.
    const estimated = 4 * 38 + 14;
    const up = rect.bottom + estimated > window.innerHeight - 12;
    setMenu({
      id,
      top: up ? rect.top - estimated : rect.bottom + 4,
      right: Math.max(8, window.innerWidth - rect.right),
      up,
    });
  };
  const [operator, setOperator] = useState(operatorName());
  const [renaming, setRenaming] = useState(false);

  const { live, councils, archived } = visibleChannels(channels);

  const archive = (channel: Channel, next: boolean): void => {
    void api
      .archiveChannel(channel.id, next)
      .then(() => {
        toast({
          kind: 'info',
          text: next ? `#${channel.name} archived` : `#${channel.name} restored`,
          action: {
            label: 'Undo',
            run: () => void api.archiveChannel(channel.id, !next).catch(console.error),
          },
        });
      })
      .catch((err: unknown) => toast({ kind: 'danger', text: String(err) }));
    setMenu(null);
  };

  /**
   * Delete is soft server-side, so the undo is a plain restore call rather than
   * anything held in memory here — it survives a reload of this tab.
   */
  const remove = (channel: Channel): void => {
    void api
      .deleteChannel(channel.id)
      .then(() => {
        toast({
          kind: 'danger',
          text: `#${channel.name} deleted`,
          ttl: 10_000,
          action: {
            label: 'Undo',
            run: () =>
              void api
                .restoreChannel(channel.id)
                .then((res) => useHive.getState().ingestChannels([res.channel]))
                .catch(console.error),
          },
        });
      })
      .catch((err: unknown) => toast({ kind: 'danger', text: String(err) }));
    setMenu(null);
  };

  const row = (channel: Channel, archivedRow = false): JSX.Element => {
    const count = unread[channel.id] ?? 0;
    const muted = prefs.mutedChannels.includes(channel.id);
    const active = channel.id === channelId && view === 'chat';
    return (
      <div key={channel.id} className={`chan ${active ? 'active' : ''} ${muted ? 'muted' : ''}`}>
        <button className="chan-main" onClick={() => openChannel(channel.id)} title={channel.description || channel.topic}>
          <Icon name={channelIcon(channel)} size={16} />
          <span className="label">{channel.name.replace('council:', '')}</span>
          {muted && <Icon name="bell-off" size={13} className="chan-muted-mark" />}
          {count > 0 && !active && <span className="chan-pip">{count > 99 ? '99+' : count}</span>}
        </button>
        <button
          className="chan-menu-btn"
          aria-label={`Actions for ${channel.name}`}
          aria-expanded={menuFor === channel.id}
          onClick={(e) => {
            e.stopPropagation();
            if (menuFor === channel.id) setMenu(null);
            else openMenu(channel.id, e.currentTarget);
          }}
        >
          <Icon name="more" size={16} />
        </button>

        {menu && menu.id === channel.id && (
          <>
            <div className="menu-scrim" onClick={() => setMenu(null)} />
            <div
              className={`menu ${menu.up ? 'up' : ''}`}
              role="menu"
              style={{ top: menu.top, right: menu.right }}
            >
              <button
                onClick={() => {
                  setEditing(channel);
                  setMenu(null);
                }}
              >
                <Icon name="edit" size={15} /> Edit purpose & topic
              </button>
              <button
                onClick={() => {
                  useHive.getState().toggleMute(channel.id);
                  setMenu(null);
                }}
              >
                <Icon name={muted ? 'bell' : 'bell-off'} size={15} />
                {muted ? 'Unmute' : 'Mute this channel'}
              </button>
              <button onClick={() => archive(channel, !archivedRow)}>
                <Icon name="archive" size={15} />
                {archivedRow ? 'Unarchive' : 'Archive'}
              </button>
              <button className="menu-danger" onClick={() => remove(channel)}>
                <Icon name="trash" size={15} /> Delete
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="col-head">
        <span className={`conn-dot ${connection}`} title={`socket ${connection}`} />
        <span>Hive</span>
        <span className="spacer" />
        <button
          className="bare"
          aria-label="Settings"
          title="Sound, notifications, do not disturb"
          onClick={() => setSettingsOpen(true)}
        >
          <Icon name="settings" size={17} />
        </button>
      </div>

      <div className="sidebar-body">
        <div className="group-label">
          <span>Channels</span>
          <button className="bare" title="New channel" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} />
          </button>
        </div>
        {live.map((channel) => row(channel))}

        {councils.length > 0 && (
          <>
            <div className="group-label">Councils</div>
            {councils.map((channel) => row(channel))}
          </>
        )}

        {archived.length > 0 && (
          <>
            <button
              className="group-toggle"
              aria-expanded={prefs.showArchived}
              onClick={() => setPrefs({ showArchived: !prefs.showArchived })}
            >
              <Icon
                name="chevron"
                size={13}
                className={prefs.showArchived ? 'chevron open' : 'chevron'}
              />
              Archived
              <span className="count">{archived.length}</span>
            </button>
            {prefs.showArchived && archived.map((channel) => row(channel, true))}
          </>
        )}
      </div>

      <div className="sidebar-foot">
        <div
          className="avatar"
          style={{ background: avatarColor(operator), width: 32, height: 32, fontSize: 12 }}
        >
          {initials(operator)}
        </div>
        {renaming ? (
          <input
            autoFocus
            value={operator}
            onChange={(e) => {
              setOperator(e.target.value);
              setOperatorName(e.target.value);
            }}
            onBlur={() => setRenaming(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setRenaming(false);
            }}
            style={{ padding: '6px 8px', fontSize: 13 }}
          />
        ) : (
          <button
            className="identity"
            onClick={() => setRenaming(true)}
            title="Click to rename — this is what appears in the audit trail"
          >
            <span className="identity-name">{operator}</span>
            <span className="identity-role">operator</span>
          </button>
        )}
      </div>

      {(creating || editing) && (
        <ChannelDialog
          channel={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={(channel) => {
            useHive.getState().ingestChannels([channel]);
            if (creating) openChannel(channel.id);
          }}
        />
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </aside>
  );
}
