import type { Channel } from '@hive/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useHive } from '../store.js';
import { Icon } from './Icon.js';

interface Props {
  /** Null creates a new channel; a channel edits it in place. */
  channel: Channel | null;
  onClose: () => void;
  onSaved: (channel: Channel) => void;
}

/**
 * Create or edit a channel.
 *
 * The purpose field is the point of this dialog. Agents are handed it verbatim
 * before they answer, so a channel with a written purpose gets on-topic replies
 * and one without gets an agent guessing from the last twelve messages. The
 * copy under the field says exactly that, because a form field labelled
 * "description" on its own gets left blank every time.
 */
export function ChannelDialog({ channel, onClose, onSaved }: Props): JSX.Element {
  const [name, setName] = useState(channel?.name ?? '');
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const [description, setDescription] = useState(channel?.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const toast = useHive((s) => s.toast);

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = (): void => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);

    const request = channel
      ? api.updateChannel(channel.id, { name: trimmed, topic, description })
      : api.createChannel({ name: trimmed, topic, description });

    void request
      .then((res) => {
        onSaved(res.channel);
        toast({
          kind: 'success',
          text: channel ? `#${res.channel.name} updated` : `#${res.channel.name} created`,
        });
        onClose();
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={channel ? 'Edit channel' : 'New channel'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row">
          <h3>{channel ? `Edit #${channel.name}` : 'New channel'}</h3>
          <span className="spacer" />
          <button className="bare" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="field">
          <label htmlFor="chan-name">Name</label>
          <input
            id="chan-name"
            ref={first}
            value={name}
            placeholder="deploys"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
            }}
          />
          <span className="hint">
            Lowercased, spaces become dashes. Agents address the channel by this name.
          </span>
        </div>

        <div className="field">
          <label htmlFor="chan-purpose">Purpose</label>
          <textarea
            id="chan-purpose"
            rows={3}
            value={description}
            placeholder="What this channel is for, and who belongs in it."
            onChange={(e) => setDescription(e.target.value)}
          />
          <span className="hint">
            Injected into every agent&apos;s context before it replies here. Leave it blank and
            agents answer blind.
          </span>
        </div>

        <div className="field">
          <label htmlFor="chan-topic">Current topic</label>
          <input
            id="chan-topic"
            value={topic}
            placeholder="Cutting 0.4 this week"
            onChange={(e) => setTopic(e.target.value)}
          />
          <span className="hint">The moving part — what the channel is on right now.</span>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !name.trim()} onClick={save}>
            {busy ? 'Saving…' : channel ? 'Save changes' : 'Create channel'}
          </button>
        </div>
      </div>
    </div>
  );
}
