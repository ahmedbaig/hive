import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { clockSeconds, truncate } from '../format.js';
import { useHive } from '../store.js';

/** Live telemetry from every machine's hooks, newest first. */
export function EventFeed({ agentFilter }: { agentFilter: string | null }): JSX.Element {
  const events = useHive((s) => s.events);
  const agents = useHive((s) => s.agents);
  const [typeFilter, setTypeFilter] = useState('');
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<typeof events>([]);

  useEffect(() => {
    void api
      .events(300)
      .then(({ events: list }) => useHive.getState().ingestEvents(list))
      .catch(() => {});
  }, []);

  // Pausing snapshots the list so a fast feed can actually be read.
  useEffect(() => {
    if (paused) setFrozen(events);
  }, [paused]);

  const source = paused ? frozen : events;
  const shown = source.filter(
    (e) =>
      (!agentFilter || e.agentId === agentFilter) && (!typeFilter || e.type.startsWith(typeFilter)),
  );

  const counts = {
    tools: source.filter((e) => e.type === 'tool.post').length,
    approvals: source.filter((e) => e.type.startsWith('permission')).length,
    prompts: source.filter((e) => e.type === 'prompt.submit').length,
  };

  return (
    <div className="pane">
      <div className="stat-grid">
        <div className="stat">
          <div className="value">{Object.values(agents).filter((a) => a.status !== 'offline').length}</div>
          <div className="label">Agents online</div>
        </div>
        <div className="stat">
          <div className="value">{counts.tools}</div>
          <div className="label">Tool calls</div>
        </div>
        <div className="stat">
          <div className="value">{counts.prompts}</div>
          <div className="label">Prompts</div>
        </div>
        <div className="stat">
          <div className="value">{counts.approvals}</div>
          <div className="label">Gate events</div>
        </div>
      </div>

      <div className="toolbar">
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All event types</option>
          <option value="tool">Tool calls</option>
          <option value="permission">Permissions</option>
          <option value="prompt">Prompts</option>
          <option value="session">Sessions</option>
          <option value="usage">Token usage</option>
          <option value="memory">Memory sync</option>
          <option value="error">Errors</option>
        </select>
        <button className="ghost" onClick={() => setPaused((p) => !p)}>
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12.5 }}>
          {shown.length} events
        </span>
      </div>

      {shown.length === 0 && (
        <div className="empty">
          Nothing yet. Events appear here as soon as a wired Claude session runs a tool.
        </div>
      )}
      {shown.map((event) => (
        <div key={event.id} className={`feed-row ${event.type.replace('.', '-')}`}>
          <span className="feed-time">{clockSeconds(event.ts)}</span>
          <span className="feed-type">{event.type}</span>
          <span className="feed-detail">
            <strong style={{ color: 'var(--fg)' }}>{event.agentName}</strong>
            {event.subject ? ` · ${event.subject}` : ''}
            {describe(event.detail)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Pick the most informative field rather than dumping the whole object. */
function describe(detail: Record<string, unknown>): string {
  if (typeof detail.output_tokens === 'number') {
    const input = Number(detail.input_tokens ?? 0) + Number(detail.cache_read_tokens ?? 0);
    return ` — ${detail.output_tokens} out / ${input} in`;
  }
  if (typeof detail.files === 'number') {
    return ` — ${detail.changed ?? 0} changed of ${detail.files}`;
  }
  for (const key of ['summary', 'command', 'file_path', 'prompt', 'message', 'decision', 'url']) {
    const value = detail[key];
    if (typeof value === 'string' && value) return ` — ${truncate(value, 110)}`;
  }
  return '';
}
