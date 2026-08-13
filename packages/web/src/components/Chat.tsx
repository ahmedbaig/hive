import type { Attachment, Message } from '@hive/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { avatarColor, bytes, clock, initials, stamp } from '../format.js';
import { useHive } from '../store.js';
import { Icon } from './Icon.js';
import { Markdown } from './Markdown.js';

interface Props {
  channelId: string;
}

/**
 * A stable empty array. A selector returning a fresh `[]` each read is compared
 * with Object.is, looks like a change every time, and re-renders forever.
 */
const NO_MESSAGES: Message[] = [];

/** Messages from the same author within this window render as one run. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

export function Chat({ channelId }: Props): JSX.Element {
  const messages = useHive((s) => s.messages[channelId] ?? NO_MESSAGES);
  const loaded = useHive((s) => s.loadedChannels.has(channelId));
  const agents = useHive((s) => s.agents);
  // An agent whose status line says it is answering is, in chat terms, typing.
  const answering = Object.values(agents).filter(
    (a) => a.status === 'working' && a.activity?.startsWith('answering'),
  );
  const [draft, setDraft] = useState('');
  const [pendingFiles, setPendingFiles] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (loaded) return;
    void api
      .messages(channelId)
      .then(({ messages: list }) => useHive.getState().ingestMessages(channelId, list))
      .catch((err) => setError(String(err)));
  }, [channelId, loaded]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = (): void => {
    const body = draft.trim();
    if ((!body && pendingFiles.length === 0) || sending) return;
    setSending(true);
    setError(null);
    const mentions = [...body.matchAll(/@([\w.-]+)/g)].map((m) => m[1] ?? '').filter(Boolean);
    void api
      .send(channelId, body || '(attachment)', mentions, pendingFiles)
      .then(() => {
        setDraft('');
        setPendingFiles([]);
        box.current?.focus();
      })
      .catch((err) => setError(String(err)))
      .finally(() => setSending(false));
  };

  const upload = (file: File): void => {
    setError(null);
    void api
      .upload(file, channelId)
      .then((stored) =>
        setPendingFiles((prev) => [
          ...prev,
          {
            fileId: stored.id,
            filename: stored.filename,
            size: stored.size,
            mime: stored.mime,
            sha256: stored.sha256,
          },
        ]),
      )
      .catch((err) => setError(String(err)));
  };

  return (
    <>
      <div className="messages">
        {messages.length === 0 && (
          <div className="empty">No messages here yet. Say something to the fleet.</div>
        )}
        {messages.map((message, index) => {
          const previous = messages[index - 1];
          const lead =
            !previous ||
            previous.authorId !== message.authorId ||
            message.ts - previous.ts > GROUP_WINDOW_MS;
          return <MessageRow key={message.id} message={message} lead={lead} />;
        })}
        <div ref={bottom} />
      </div>

      <div className="composer">
        {pendingFiles.length > 0 && (
          <div className="chips">
            {pendingFiles.map((f) => (
              <span key={f.fileId} className="chip">
                📎 {f.filename} · {bytes(f.size)}
                <button
                  className="icon-btn"
                  style={{ fontSize: 14 }}
                  onClick={() =>
                    setPendingFiles((prev) => prev.filter((p) => p.fileId !== f.fileId))
                  }
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="composer-box">
          <label className="bare" title="Attach a file" style={{ cursor: 'pointer', padding: '6px 4px' }}>
            <Icon name="paperclip" size={18} />
            <input
              type="file"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload(file);
                e.target.value = '';
              }}
            />
          </label>
          <textarea
            ref={box}
            rows={1}
            value={draft}
            placeholder="Message the fleet — @name to address one agent, @all for everyone"
            onChange={(e) => {
              setDraft(e.target.value);
              // Grow with content up to the CSS max-height, then scroll.
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="primary tiny" disabled={sending} onClick={send} title="Send">
            <Icon name="send" size={14} />
            Send
          </button>
        </div>

        <div className={`composer-meta ${error ? 'error' : ''}`}>
          {error ? (
            error
          ) : answering.length > 0 ? (
            <span className="typing">
              <i />
              <i />
              <i />
              {answering.map((a) => a.name).join(', ')} {answering.length > 1 ? 'are' : 'is'} typing
            </span>
          ) : (
            'Enter to send · Shift+Enter for a new line · @name to address one agent'
          )}
        </div>
      </div>
    </>
  );
}

function MessageRow({ message, lead }: { message: Message; lead: boolean }): JSX.Element {
  const color = avatarColor(message.authorName);
  return (
    <div className={`msg ${lead ? 'lead' : ''}`}>
      <div className="gutter">
        {lead ? (
          <div className="avatar" style={{ background: color }}>
            {initials(message.authorName)}
          </div>
        ) : (
          <span className="timestamp-hover">{clock(message.ts)}</span>
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        {lead && (
          <div className="msg-head">
            <span className="msg-author" style={{ color }}>
              {message.authorName}
            </span>
            {message.authorType === 'agent' && <span className="tag">agent</span>}
            {message.authorType === 'system' && <span className="tag system">system</span>}
            {message.authorType === 'human' && <span className="tag human">you</span>}
            <span className="msg-time">{stamp(message.ts)}</span>
          </div>
        )}
        <div className="msg-body">
          <Markdown text={message.body} />
        </div>
        {message.attachments.map((a) => (
          <a key={a.fileId} className="attach" href={`/api/files/${a.fileId}`} download>
            📎 <span>{a.filename}</span>
            <span className="muted">{bytes(a.size)}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
