import type { Council } from '@hive/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { relative } from '../format.js';
import { useHive } from '../store.js';

/**
 * Councils are debates with structure: participants state positions, argue for
 * a bounded number of rounds, then vote. The transcript itself is ordinary chat
 * in the council's channel, so this view handles phase control and the tally.
 */
export function CouncilView({ onOpenChannel }: { onOpenChannel: (id: string) => void }): JSX.Element {
  const councils = useHive((s) => s.councils);
  const agents = useHive((s) => s.agents);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void api
      .councils()
      .then(({ councils: list }) => useHive.getState().ingestCouncils(list))
      .catch(() => {});
  }, []);

  const list = Object.values(councils).sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="pane">
      <div className="row" style={{ marginBottom: 12 }}>
        <strong>Councils</strong>
        <span className="spacer" />
        <button className="primary" onClick={() => setCreating(true)}>
          Convene
        </button>
      </div>

      {list.length === 0 && (
        <div className="empty">
          No councils yet. Convene one to have the fleet debate a decision and vote on it.
        </div>
      )}

      {list.map((council) => (
        <CouncilCard
          key={council.id}
          council={council}
          agentNames={Object.fromEntries(Object.values(agents).map((a) => [a.id, a.name]))}
          onOpenChannel={onOpenChannel}
        />
      ))}

      {creating && <ConveneModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function CouncilCard({
  council,
  agentNames,
  onOpenChannel,
}: {
  council: Council;
  agentNames: Record<string, string>;
  onOpenChannel: (id: string) => void;
}): JSX.Element {
  const tally = new Map<string, number>();
  for (const vote of council.votes) tally.set(vote.option, (tally.get(vote.option) ?? 0) + 1);
  const totalVotes = council.votes.length;

  return (
    <div className="card">
      <div className="row">
        <strong>{council.topic}</strong>
        <span className={`phase ${council.phase === 'closed' ? 'closed' : ''}`}>{council.phase}</span>
        {council.phase === 'debate' && (
          <span className="muted">
            round {council.round}/{council.maxRounds}
          </span>
        )}
        <span className="spacer" />
        <span className="muted">{relative(council.createdAt)}</span>
      </div>

      <div className="dim" style={{ margin: '5px 0' }}>
        {council.question}
      </div>

      <div className="muted" style={{ fontSize: 11 }}>
        {council.participants.length} participant(s):{' '}
        {council.participants.map((id) => agentNames[id] ?? id).join(', ') || 'none yet'}
      </div>

      {totalVotes > 0 && (
        <div style={{ margin: '8px 0' }}>
          {[...tally.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([option, count]) => (
              <div key={option} style={{ marginBottom: 5 }}>
                <div className="row" style={{ fontSize: 11.5 }}>
                  <span>{option}</span>
                  <span className="spacer" />
                  <span className="muted">
                    {count}/{totalVotes}
                  </span>
                </div>
                <div className="vote-bar">
                  <div style={{ width: `${(count / totalVotes) * 100}%` }} />
                </div>
              </div>
            ))}
        </div>
      )}

      {council.verdict && (
        <div style={{ color: 'var(--council)', fontWeight: 600 }}>Verdict: {council.verdict}</div>
      )}
      {council.phase === 'closed' && !council.verdict && (
        <div className="muted">Closed with no consensus — tie or no votes cast.</div>
      )}

      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => onOpenChannel(council.channelId)}>Open transcript</button>
        {council.phase !== 'closed' && (
          <button
            className="primary"
            onClick={() => void api.advanceCouncil(council.id).catch(console.error)}
          >
            {council.phase === 'voting' ? 'Close & tally' : 'Advance phase'}
          </button>
        )}
      </div>
    </div>
  );
}

function ConveneModal({ onClose }: { onClose: () => void }): JSX.Element {
  const agents = useHive((s) => s.agents);
  const live = Object.values(agents).filter((a) => a.status !== 'offline');
  const [topic, setTopic] = useState('');
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState('');
  const [maxRounds, setMaxRounds] = useState(3);
  const [participants, setParticipants] = useState<string[]>(live.map((a) => a.id));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (): void => {
    if (!topic.trim() || !question.trim()) {
      setError('Topic and question are both required.');
      return;
    }
    setBusy(true);
    void api
      .openCouncil({
        topic: topic.trim(),
        question: question.trim(),
        options: options
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
        participants,
        maxRounds,
      })
      .then(onClose)
      .catch((err) => {
        setError(String(err));
        setBusy(false);
      });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Convene a council</h3>
        <div className="field">
          <label>Topic (short name)</label>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="db-choice" />
        </div>
        <div className="field">
          <label>Question to debate</label>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Should we move the event store from Redis streams to Postgres partitions?"
          />
        </div>
        <div className="field">
          <label>Vote options (comma separated, blank for free-form)</label>
          <input
            value={options}
            onChange={(e) => setOptions(e.target.value)}
            placeholder="stay, migrate, hybrid"
          />
        </div>
        <div className="field">
          <label>Max debate rounds</label>
          <input
            type="number"
            min={1}
            max={10}
            value={maxRounds}
            onChange={(e) => setMaxRounds(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label>Participants</label>
          {live.length === 0 && <span className="muted">No live agents to invite.</span>}
          {live.map((agent) => (
            <label key={agent.id} className="checkbox-row">
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={participants.includes(agent.id)}
                onChange={(e) =>
                  setParticipants((prev) =>
                    e.target.checked ? [...prev, agent.id] : prev.filter((p) => p !== agent.id),
                  )
                }
              />
              {agent.name} <span className="muted">{agent.host}</span>
            </label>
          ))}
        </div>
        {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
        <div className="row">
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy} onClick={submit}>
            Convene
          </button>
        </div>
      </div>
    </div>
  );
}
