import { useEffect } from 'react';
import { api } from './api.js';
import { Chat } from './components/Chat.js';
import { CouncilView } from './components/CouncilView.js';
import { EventFeed } from './components/EventFeed.js';
import { Files } from './components/Files.js';
import { Icon, type IconName } from './components/Icon.js';
import { RightRail } from './components/RightRail.js';
import { Sidebar, channelIcon } from './components/Sidebar.js';
import { StatsView } from './components/StatsView.js';
import { Toasts } from './components/Toasts.js';
import { connectSocket, useHive, type View } from './store.js';

const VIEWS: Array<{ id: View; icon: IconName; label: string }> = [
  { id: 'chat', icon: 'chat', label: 'Chat' },
  { id: 'feed', icon: 'activity', label: 'Live feed' },
  { id: 'stats', icon: 'gauge', label: 'Usage' },
  { id: 'council', icon: 'scale', label: 'Council' },
  { id: 'files', icon: 'folder', label: 'Files' },
];

export function App(): JSX.Element {
  const view = useHive((s) => s.view);
  const channelId = useHive((s) => s.channelId);
  const channels = useHive((s) => s.channels);
  const killSwitch = useHive((s) => s.killSwitch);
  const permissions = useHive((s) => s.permissions);
  const unread = useHive((s) => s.unread);
  const prefs = useHive((s) => s.prefs);
  const drawerOpen = useHive((s) => s.drawerOpen);
  const railOpen = useHive((s) => s.railOpen);
  const selectedAgent = useHive((s) => s.selectedAgent);

  const setView = useHive((s) => s.setView);
  const setDrawer = useHive((s) => s.setDrawer);
  const setRail = useHive((s) => s.setRail);
  const selectAgent = useHive((s) => s.selectAgent);
  const toggleMute = useHive((s) => s.toggleMute);

  useEffect(() => connectSocket(), []);

  // Escape closes whichever overlay is open, in the order a user expects.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (railOpen) setRail(false);
      else if (drawerOpen) setDrawer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen, railOpen, setDrawer, setRail]);

  const active = channels[channelId];
  const pendingCount = Object.values(permissions).filter((p) => p.status === 'pending').length;
  const totalUnread = Object.entries(unread)
    .filter(([id]) => !prefs.mutedChannels.includes(id))
    .reduce((sum, [, count]) => sum + count, 0);
  const muted = prefs.mutedChannels.includes(channelId);

  return (
    <div className={`app ${drawerOpen ? 'drawer-open' : ''} ${railOpen ? 'rail-open' : ''}`}>
      <nav className="rail" aria-label="Views">
        <div className="rail-logo">
          <Icon name="cpu" size={21} />
        </div>
        <div className="rail-divider" />
        {VIEWS.map((item) => (
          <button
            key={item.id}
            className={`rail-btn ${view === item.id ? 'active' : ''}`}
            title={item.label}
            aria-label={item.label}
            aria-current={view === item.id}
            onClick={() => setView(item.id)}
          >
            <Icon name={item.icon} size={19} />
            {item.id === 'chat' && totalUnread > 0 && (
              <span className="pip">{totalUnread > 99 ? '99+' : totalUnread}</span>
            )}
          </button>
        ))}
        <div className="rail-spacer" />
        <button
          className={`rail-btn ${killSwitch ? 'danger-state' : ''}`}
          title={killSwitch ? 'Release the kill switch' : 'Kill switch — deny every tool call'}
          aria-label="Kill switch"
          onClick={() => void api.killSwitch(!killSwitch, 'stopped from dashboard').catch(console.error)}
        >
          <Icon name="ban" size={19} />
        </button>
      </nav>

      <Sidebar />

      <main className="main">
        {killSwitch && (
          <div className="banner">
            <Icon name="alert" size={16} />
            <span>Kill switch engaged — every tool call across the fleet is being denied.</span>
            <span className="spacer" />
            <button className="tiny" onClick={() => void api.killSwitch(false).catch(console.error)}>
              Release
            </button>
          </div>
        )}

        <header className="col-head">
          <button
            className="icon-btn only-sm"
            aria-label="Open channels"
            onClick={() => setDrawer(true)}
          >
            <Icon name="menu" size={20} />
          </button>

          {view === 'chat' && active ? (
            <>
              <span className="head-title">
                <Icon name={channelIcon(active)} size={17} className="muted" />
                <span className="head-name">{active.name}</span>
              </span>
              {(active.topic || active.description) && (
                <>
                  <span className="vline hide-sm" />
                  <span className="topic hide-sm" title={active.description || undefined}>
                    {active.topic || active.description}
                  </span>
                </>
              )}
            </>
          ) : (
            <span className="head-title">
              <span className="head-name">{VIEWS.find((v) => v.id === view)?.label}</span>
            </span>
          )}

          <span className="spacer" />

          {view === 'feed' && selectedAgent && (
            <button className="ghost tiny" onClick={() => selectAgent(null)}>
              Clear filter
            </button>
          )}

          {view === 'chat' && active && (
            <button
              className="icon-btn"
              aria-label={muted ? `Unmute ${active.name}` : `Mute ${active.name}`}
              title={muted ? 'Unmute this channel' : 'Mute this channel'}
              onClick={() => toggleMute(active.id)}
            >
              <Icon name={muted ? 'bell-off' : 'bell'} size={18} />
            </button>
          )}

          <button
            className="icon-btn only-narrow"
            aria-label="Approvals and agents"
            onClick={() => setRail(true)}
          >
            <Icon name="shield" size={18} />
            {pendingCount > 0 && <span className="pip">{pendingCount}</span>}
          </button>
        </header>

        {/*
          Keyed on the view so switching tabs replays the enter animation. It is
          deliberately not keyed on the channel: remounting on channel switch is
          what used to throw away the composer draft.
        */}
        <div className="view" key={view}>
          {view === 'chat' && <Chat channelId={channelId} />}
          {view === 'feed' && <EventFeed agentFilter={selectedAgent} />}
          {view === 'stats' && <StatsView />}
          {view === 'council' && (
            <CouncilView onOpenChannel={(id) => useHive.getState().openChannel(id)} />
          )}
          {view === 'files' && <Files />}
        </div>
      </main>

      <RightRail selected={selectedAgent} onSelect={selectAgent} />

      {/* One scrim for both overlays; whichever is open owns it. */}
      <div
        className="scrim"
        onClick={() => {
          setDrawer(false);
          setRail(false);
        }}
      />

      <nav className="tabbar" aria-label="Views">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            className={`tab ${view === item.id ? 'active' : ''}`}
            aria-current={view === item.id}
            onClick={() => setView(item.id)}
          >
            <Icon name={item.icon} size={20} />
            <span>{item.label}</span>
            {item.id === 'chat' && totalUnread > 0 && <span className="pip">{totalUnread}</span>}
          </button>
        ))}
      </nav>

      <Toasts />
    </div>
  );
}
