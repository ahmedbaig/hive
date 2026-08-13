import type { Channel } from '@hive/shared';
import { useEffect, useState } from 'react';
import { api, operatorName, setOperatorName } from './api.js';
import { Chat } from './components/Chat.js';
import { CouncilView } from './components/CouncilView.js';
import { EventFeed } from './components/EventFeed.js';
import { Files } from './components/Files.js';
import { Icon, type IconName } from './components/Icon.js';
import { RightRail } from './components/RightRail.js';
import { avatarColor, initials } from './format.js';
import { connectSocket, useHive } from './store.js';

type View = 'chat' | 'feed' | 'council' | 'files';

const VIEWS: Array<{ id: View; icon: IconName; label: string }> = [
  { id: 'chat', icon: 'chat', label: 'Chat' },
  { id: 'feed', icon: 'activity', label: 'Live feed' },
  { id: 'council', icon: 'scale', label: 'Council' },
  { id: 'files', icon: 'folder', label: 'Files' },
];

/** Fixed icon per channel so the sidebar reads at a glance. */
function channelIcon(channel: Channel): IconName {
  if (channel.kind === 'council') return 'scale';
  if (channel.kind === 'direct') return 'at';
  if (channel.kind === 'system') return 'megaphone';
  if (channel.name === 'memory') return 'brain';
  if (channel.name === 'sessions') return 'thread';
  if (channel.name === 'ops') return 'wrench';
  return 'hash';
}

export function App(): JSX.Element {
  const connection = useHive((s) => s.connection);
  const channels = useHive((s) => s.channels);
  const killSwitch = useHive((s) => s.killSwitch);
  const permissions = useHive((s) => s.permissions);

  const [view, setView] = useState<View>('chat');
  const [channelId, setChannelId] = useState('chn_lobby');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [operator, setOperator] = useState(operatorName());
  const [editingName, setEditingName] = useState(false);

  useEffect(() => connectSocket(), []);

  const channelList = Object.values(channels)
    .filter((c) => !c.archived)
    .sort((a, b) => a.createdAt - b.createdAt);
  const active = channels[channelId];
  const pendingCount = Object.values(permissions).filter((p) => p.status === 'pending').length;

  const chatChannels = channelList.filter((c) => c.kind !== 'council');
  const councilChannels = channelList.filter((c) => c.kind === 'council');

  return (
    <div className="app">
      <nav className="rail">
        <div className="rail-logo"><Icon name="cpu" size={21} /></div>
        <div className="rail-divider" />
        {VIEWS.map((item) => (
          <div
            key={item.id}
            className={`rail-btn ${view === item.id ? 'active' : ''}`}
            title={item.label}
            onClick={() => setView(item.id)}
          >
            <Icon name={item.icon} size={19} />
            {item.id === 'chat' && pendingCount > 0 && <span className="pip">{pendingCount}</span>}
          </div>
        ))}
        <div className="rail-spacer" />
        <div
className={`rail-btn ${killSwitch ? 'danger-state' : ''}`}
          title={killSwitch ? 'Release the kill switch' : 'Kill switch — deny every tool call'}
          onClick={() =>
            void api.killSwitch(!killSwitch, 'stopped from dashboard').catch(console.error)
          }
        >
          <Icon name="ban" size={19} />
        </div>
      </nav>

      <aside className="sidebar">
        <div className="col-head">
          <span className={`conn-dot ${connection}`} />
          <span>Hive</span>
          <span className="spacer" />
          <span className="muted" style={{ fontSize: 11.5, fontWeight: 500 }}>
            {connection}
          </span>
        </div>

        <div className="sidebar-body">
          <div className="group-label">
            <span>Channels</span>
            <button className="bare"
              title="New channel"
              onClick={() => {
                const name = prompt('Channel name');
                if (!name) return;
                void api
                  .createChannel({ name })
                  .then(({ channel }) => {
                    setChannelId(channel.id);
                    setView('chat');
                  })
                  .catch(console.error);
              }}
            >
              <Icon name="plus" size={15} />
            </button>
          </div>
          {chatChannels.map((channel) => (
            <div
              key={channel.id}
              className={`chan ${channel.id === channelId && view === 'chat' ? 'active' : ''}`}
              onClick={() => {
                setChannelId(channel.id);
                setView('chat');
              }}
            >
              <Icon name={channelIcon(channel)} size={16} />
              <span className="label">{channel.name}</span>
            </div>
          ))}

          {councilChannels.length > 0 && (
            <>
              <div className="group-label">Councils</div>
              {councilChannels.map((channel) => (
                <div
                  key={channel.id}
                  className={`chan ${channel.id === channelId && view === 'chat' ? 'active' : ''}`}
                  onClick={() => {
                    setChannelId(channel.id);
                    setView('chat');
                  }}
                >
                  <Icon name={channelIcon(channel)} size={16} />
                  <span className="label">{channel.name.replace('council:', '')}</span>
                </div>
              ))}
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
          {editingName ? (
            <input
              autoFocus
              value={operator}
              onChange={(e) => {
                setOperator(e.target.value);
                setOperatorName(e.target.value);
              }}
              onBlur={() => setEditingName(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setEditingName(false);
              }}
              style={{ padding: '4px 8px', fontSize: 13 }}
            />
          ) : (
            <div
              style={{ cursor: 'pointer', minWidth: 0 }}
              onClick={() => setEditingName(true)}
              title="Click to rename — this is what appears in the audit trail"
            >
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{operator}</div>
              <div className="muted" style={{ fontSize: 11.5 }}>
                operator
              </div>
            </div>
          )}
        </div>
      </aside>

      <main className="main">
        {killSwitch && (
          <div className="banner">
            <Icon name="alert" size={16} /> Kill switch engaged — every tool call across the fleet is being denied.
            <span className="spacer" />
            <button
              className="tiny"
              onClick={() => void api.killSwitch(false).catch(console.error)}
            >
              Release
            </button>
          </div>
        )}

        <div className="col-head">
          {view === 'chat' && active ? (
            <>
              <span className="row" style={{ gap: 7, minWidth: 0 }}>
                <Icon name={channelIcon(active)} size={17} className="muted" />
                {active.name}
              </span>
              {active.topic && (
                <>
                  <span className="vline" />
                  <span className="topic">{active.topic}</span>
                </>
              )}
            </>
          ) : (
            <span className="row" style={{ gap: 7, minWidth: 0 }}>{VIEWS.find((v) => v.id === view)?.label}</span>
          )}
          <span className="spacer" />
          {view === 'feed' && selectedAgent && (
            <button className="ghost tiny" onClick={() => setSelectedAgent(null)}>
              Clear agent filter
            </button>
          )}
        </div>

        {view === 'chat' && <Chat key={channelId} channelId={channelId} />}
        {view === 'feed' && <EventFeed agentFilter={selectedAgent} />}
        {view === 'council' && (
          <CouncilView
            onOpenChannel={(id) => {
              setChannelId(id);
              setView('chat');
            }}
          />
        )}
        {view === 'files' && <Files />}
      </main>

      <RightRail selected={selectedAgent} onSelect={setSelectedAgent} />
    </div>
  );
}
