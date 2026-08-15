import type { AgentRecord, PermissionRequest } from '@hive/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { avatarColor, initials, relative, truncate } from '../format.js';
import { useHive } from '../store.js';
import { Icon } from './Icon.js';

/**
 * The right rail answers exactly one question: what is Claude asking me to
 * approve?
 *
 * Running work is deliberately NOT shown here. An agent's current activity
 * already appears under its name in the agent list, and mixing it into this
 * column made routine work look like it needed a decision. Everything in the
 * approvals block is blocking an agent right now.
 */
export function RightRail({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (agentId: string | null) => void;
}): JSX.Element {
  const permissions = useHive((s) => s.permissions);
  const agents = useHive((s) => s.agents);

  useEffect(() => {
    void api
      .pending()
      .then(({ pending }) => useHive.getState().ingestPermissions(pending))
      .catch(() => {});
  }, []);

  const pending = Object.values(permissions)
    .filter((p) => p.status === 'pending')
    .sort((a, b) => a.ts - b.ts);

  const decided = Object.values(permissions)
    .filter((p) => p.status !== 'pending' && p.status !== 'auto_allowed')
    .sort((a, b) => (b.decidedAt ?? b.ts) - (a.decidedAt ?? a.ts))
    .slice(0, 6);

  const list = Object.values(agents).sort(byLivenessThenName);
  const online = list.filter((a) => a.status !== 'offline').length;

  return (
    <div className="right-rail">
      <div className="col-head">
        <Icon name="shield" size={17} />
        <span>Approvals</span>
        <span className="spacer" />
        {pending.length > 0 && <span className="approval-tool">{pending.length}</span>}
        <button
          className="icon-btn only-narrow"
          aria-label="Close"
          onClick={() => useHive.getState().setRail(false)}
        >
          <Icon name="close" size={18} />
        </button>
      </div>

      <div className="right-body">
        {pending.length === 0 ? (
          <div className="empty" style={{ padding: '26px 12px' }}>
            <Icon name="check" size={22} />
            <div style={{ marginTop: 8 }}>Nothing waiting on you.</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              Tool calls that need a decision appear here.
            </div>
          </div>
        ) : (
          pending.map((request) => <ApprovalCard key={request.id} request={request} />)
        )}

        {decided.length > 0 && (
          <>
            <div className="group-label">Recently decided</div>
            {decided.map((p) => (
              <div key={p.id} className="decided" title={p.summary}>
                <span className={`verdict ${p.status}`}>{p.status}</span>
                <span
                  className="mono"
                  style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {truncate(p.summary, 42)}
                </span>
              </div>
            ))}
          </>
        )}

        <div className="group-label">
          <span>Agents</span>
          <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>
            {online}/{list.length} online
          </span>
        </div>
        {list.length === 0 && <div className="empty">No agents registered.</div>}
        {list.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            selected={selected === agent.id}
            onSelect={() => onSelect(selected === agent.id ? null : agent.id)}
          />
        ))}
      </div>
    </div>
  );
}

function AgentRow({
  agent,
  selected,
  onSelect,
}: {
  agent: AgentRecord;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const color = avatarColor(agent.name);
  const offline = agent.status === 'offline';
  return (
    <div
      className={`agent-row ${selected ? 'selected' : ''}`}
      onClick={onSelect}
      style={{ opacity: offline ? 0.5 : 1 }}
      title={agent.cwd}
    >
      <div className="agent-avatar">
        <div className="avatar" style={{ background: color, width: 32, height: 32, fontSize: 11.5 }}>
          {initials(agent.name)}
        </div>
        <span className={`presence ${agent.status}`} />
      </div>
      <div className="agent-meta">
        <div className="agent-name">{agent.name}</div>
        <div className="agent-sub">
          {offline ? `offline · ${relative(agent.lastSeen)}` : (agent.activity ?? agent.status)}
        </div>
      </div>
      {selected && !offline && (
        <button
          className="bare"
          title="Interrupt this agent"
          onClick={(e) => {
            e.stopPropagation();
            void api.command(agent.id, 'stop', 'operator stop').catch(console.error);
          }}
        >
          <Icon name="stop" size={15} />
        </button>
      )}
    </div>
  );
}

function ApprovalCard({ request }: { request: PermissionRequest }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const remaining = useCountdown(request.expiresAt);

  const decide = (decision: 'allow' | 'deny'): void => {
    setBusy(true);
    void api
      .decide(request.id, decision, reason || null)
      .catch(console.error)
      .finally(() => setBusy(false));
  };

  return (
    <div className="approval">
      <div className="approval-head">
        <span className="approval-tool">{request.toolName}</span>
        <strong style={{ fontSize: 13 }}>{request.agentName}</strong>
        <span className="countdown">{remaining > 0 ? `${remaining}s` : 'expired'}</span>
      </div>
      <div className="approval-cmd">{request.summary}</div>
      <div className="mono muted" style={{ fontSize: 10.5, marginBottom: 9 }}>
        {request.cwd}
      </div>
      <input
        placeholder="reason (optional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        style={{ marginBottom: 9, padding: '7px 9px', fontSize: 12.5 }}
      />
      <div className="approval-actions">
        <button className="ok" disabled={busy} onClick={() => decide('allow')}>
          <Icon name="check" size={15} /> Allow
        </button>
        <button className="danger" disabled={busy} onClick={() => decide('deny')}>
          <Icon name="ban" size={15} /> Deny
        </button>
      </div>
    </div>
  );
}

function useCountdown(expiresAt: number): number {
  const [remaining, setRemaining] = useState(() => secondsLeft(expiresAt));
  useEffect(() => {
    const timer = setInterval(() => setRemaining(secondsLeft(expiresAt)), 1_000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return remaining;
}

const secondsLeft = (expiresAt: number): number =>
  Math.max(0, Math.round((expiresAt - Date.now()) / 1000));

const ORDER: Record<AgentRecord['status'], number> = {
  waiting_approval: 0,
  working: 1,
  idle: 2,
  paused: 3,
  offline: 4,
};

function byLivenessThenName(a: AgentRecord, b: AgentRecord): number {
  const diff = ORDER[a.status] - ORDER[b.status];
  return diff !== 0 ? diff : a.name.localeCompare(b.name);
}
