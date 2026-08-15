import type { Attachment, Message } from '@hive/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

/** How close to the bottom still counts as "following the conversation". */
const STICK_THRESHOLD_PX = 120;

/** Most mention candidates shown at once; the list is a hint, not a directory. */
const MENTION_LIMIT = 8;

/**
 * The `@…` token being typed immediately before the caret, if any.
 *
 * Only a token that starts the line or follows whitespace counts, so an email
 * address or a `foo@bar` path does not open the picker mid-word.
 */
function mentionToken(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = /(?:^|\s)@([\w.-]*)$/.exec(before);
  if (!match) return null;
  const query = match[1] ?? '';
  return { start: caret - query.length - 1, query };
}

export function Chat({ channelId }: Props): JSX.Element {
  const messages = useHive((s) => s.messages[channelId] ?? NO_MESSAGES);
  const loaded = useHive((s) => s.loadedChannels.has(channelId));
  const agents = useHive((s) => s.agents);
  const channel = useHive((s) => s.channels[channelId]);
  // The draft lives in the store, keyed by channel. It used to be component
  // state, and the component was remounted on every channel switch, so
  // clicking another channel to check something threw away what you were
  // halfway through typing.
  const draft = useHive((s) => s.drafts[channelId] ?? '');
  const setDraft = useHive((s) => s.setDraft);
  const scrollTops = useHive((s) => s.scrollTops);
  const setScrollTop = useHive((s) => s.setScrollTop);

  // An agent whose status line says it is answering is, in chat terms, typing.
  const answering = Object.values(agents).filter(
    (a) => a.status === 'working' && a.activity?.startsWith('answering'),
  );

  // The `@…` picker. `null` when the caret is not inside a mention token.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionPick, setMentionPick] = useState(0);

  const [pendingFiles, setPendingFiles] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newBelow, setNewBelow] = useState(0);

  const listRef = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const lastCount = useRef(messages.length);

  useEffect(() => {
    if (loaded) return;
    void api
      .messages(channelId)
      .then(({ messages: list }) => useHive.getState().ingestMessages(channelId, list))
      .catch((err: unknown) => setError(String(err)));
  }, [channelId, loaded]);

  /**
   * Restore the scroll position for this channel before paint.
   *
   * `useLayoutEffect` rather than `useEffect`: with the latter the list renders
   * at the top for one frame and then jumps, which reads as a flicker on every
   * channel switch.
   */
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const saved = scrollTops[channelId];
    el.scrollTop = saved ?? el.scrollHeight;
    setAtBottom(saved === undefined || el.scrollHeight - saved - el.clientHeight < STICK_THRESHOLD_PX);
    setNewBelow(0);
    setMention(null);
    // Rebase the counter the follow-the-bottom effect compares against.
    // Without this, moving to a busier channel looks like a burst of arrivals
    // and pops a "12 new messages" pill for messages that are simply older.
    lastCount.current = messages.length;
    // Restoring is per channel; re-running it when the saved value changes
    // would fight the user's own scrolling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  /**
   * Follow new messages only when already at the bottom. Yanking someone who is
   * reading back-scroll down to the newest message is the single most annoying
   * thing a chat client does.
   */
  useEffect(() => {
    const grew = messages.length > lastCount.current;
    lastCount.current = messages.length;
    if (!grew) return;
    const el = listRef.current;
    if (!el) return;
    if (atBottom) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else setNewBelow((n) => n + 1);
  }, [messages.length, atBottom]);

  const onScroll = (): void => {
    const el = listRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
    setAtBottom(bottom);
    if (bottom) setNewBelow(0);
    setScrollTop(channelId, el.scrollTop);
  };

  const jumpToBottom = (): void => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setNewBelow(0);
  };

  /**
   * Mention candidates for the token being typed. `all` is listed first because
   * broadcasting is the one target that has no name to remember.
   */
  const roster: Array<{ name: string; hint: string; status: string }> = [
    { name: 'all', hint: 'everyone in this channel', status: 'broadcast' },
    ...Object.values(agents)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => ({ name: a.name, hint: a.activity || a.host, status: a.status })),
  ];
  const candidates =
    mention === null
      ? []
      : roster
          .filter((c) => c.name.toLowerCase().startsWith(mention.query.toLowerCase()))
          .slice(0, MENTION_LIMIT);
  // An open picker with nothing in it must not swallow Enter.
  const picking = mention !== null && candidates.length > 0;

  /** Replace the half-typed token with `@name ` and put the caret after it. */
  const acceptMention = (name: string): void => {
    if (mention === null) return;
    const el = box.current;
    const caret = el ? el.selectionStart : mention.start + mention.query.length + 1;
    const next = `${draft.slice(0, mention.start)}@${name} ${draft.slice(caret)}`;
    const at = mention.start + name.length + 2;
    setDraft(channelId, next);
    setMention(null);
    setMentionPick(0);
    requestAnimationFrame(() => {
      const box2 = box.current;
      if (!box2) return;
      box2.focus();
      box2.setSelectionRange(at, at);
    });
  };

  /** Recompute the picker from wherever the caret now is. */
  const syncMention = (el: HTMLTextAreaElement): void => {
    const found = mentionToken(el.value, el.selectionStart);
    setMention(found);
    setMentionPick(0);
  };

  const send = (): void => {
    const body = draft.trim();
    if ((!body && pendingFiles.length === 0) || sending) return;
    setSending(true);
    setError(null);
    const mentions = [...body.matchAll(/@([\w.-]+)/g)].map((m) => m[1] ?? '').filter(Boolean);
    void api
      .send(channelId, body || '(attachment)', mentions, pendingFiles)
      .then(() => {
        setDraft(channelId, '');
        setMention(null);
        setPendingFiles([]);
        if (box.current) {
          box.current.style.height = 'auto';
          box.current.focus();
        }
        setAtBottom(true);
      })
      .catch((err: unknown) => setError(String(err)))
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
      .catch((err: unknown) => setError(String(err)));
  };

  return (
    <>
      <div className="messages" ref={listRef} onScroll={onScroll}>
        {messages.length === 0 && (
          <div className="empty">
            <Icon name="chat" size={26} />
            <div style={{ marginTop: 10 }}>Nothing here yet.</div>
            {channel?.description ? (
              <div className="empty-purpose">{channel.description}</div>
            ) : (
              <div style={{ fontSize: 12.5, marginTop: 6 }}>
                Say something to the fleet — or give this channel a purpose so agents know what it
                is for.
              </div>
            )}
          </div>
        )}
        {messages.map((message, index) => {
          const previous = messages[index - 1];
          const lead =
            !previous ||
            previous.authorId !== message.authorId ||
            message.ts - previous.ts > GROUP_WINDOW_MS;
          const dayBreak = previous ? !sameDay(previous.ts, message.ts) : false;
          return (
            <div key={message.id}>
              {dayBreak && (
                <div className="day-break">
                  <span>{new Date(message.ts).toLocaleDateString()}</span>
                </div>
              )}
              <MessageRow message={message} lead={lead} fresh={index >= messages.length - 1} />
            </div>
          );
        })}
      </div>

      {newBelow > 0 && (
        <button className="jump-btn" onClick={jumpToBottom}>
          <Icon name="arrow-down" size={14} />
          {newBelow} new {newBelow === 1 ? 'message' : 'messages'}
        </button>
      )}

      <div className="composer">
        {pendingFiles.length > 0 && (
          <div className="chips">
            {pendingFiles.map((f) => (
              <span key={f.fileId} className="chip">
                <Icon name="paperclip" size={12} /> {f.filename} · {bytes(f.size)}
                <button
                  className="bare"
                  aria-label={`Remove ${f.filename}`}
                  onClick={() => setPendingFiles((prev) => prev.filter((p) => p.fileId !== f.fileId))}
                >
                  <Icon name="close" size={13} />
                </button>
              </span>
            ))}
          </div>
        )}

        {picking && (
          <div className="mention-pop" role="listbox" aria-label="Mention an agent">
            {candidates.map((c, i) => (
              <button
                key={c.name}
                role="option"
                aria-selected={i === mentionPick}
                className={`mention-row ${i === mentionPick ? 'on' : ''}`}
                // mousedown, not click: the textarea must not lose focus and
                // close the picker before the choice is registered.
                onMouseDown={(e) => {
                  e.preventDefault();
                  acceptMention(c.name);
                }}
                onMouseEnter={() => setMentionPick(i)}
              >
                <span
                  className="mention-dot"
                  style={{ background: c.name === 'all' ? 'var(--accent)' : avatarColor(c.name) }}
                >
                  {c.name === 'all' ? '@' : initials(c.name)}
                </span>
                <span className="mention-name">@{c.name}</span>
                <span className="mention-hint">{c.hint}</span>
              </button>
            ))}
            <div className="mention-foot">↑↓ to move · Enter or Tab to pick · Esc to dismiss</div>
          </div>
        )}

        <div className="composer-box">
          <label className="attach-btn" title="Attach a file">
            <Icon name="paperclip" size={19} />
            <input
              type="file"
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
            placeholder="Message the fleet — @name for one agent, @all for everyone"
            onChange={(e) => {
              setDraft(channelId, e.target.value);
              syncMention(e.target);
              // Grow with content up to the CSS max-height, then scroll.
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
            }}
            // Arrow keys and clicks move the caret out of (or into) a token
            // without changing the text, so the picker is resynced here too.
            onKeyUp={(e) => {
              if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End')
                syncMention(e.currentTarget);
            }}
            onClick={(e) => syncMention(e.currentTarget)}
            onBlur={() => setMention(null)}
            onKeyDown={(e) => {
              if (picking) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMentionPick((i) => (i + 1) % candidates.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMentionPick((i) => (i - 1 + candidates.length) % candidates.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  acceptMention(candidates[mentionPick]?.name ?? candidates[0]!.name);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setMention(null);
                  return;
                }
              }
              // Enter sends on a pointer device. On a touch keyboard Enter is
              // the only way to get a newline, so it must not send there.
              if (e.key === 'Enter' && !e.shiftKey && !isTouch()) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            className="send-btn"
            disabled={sending || (!draft.trim() && pendingFiles.length === 0)}
            onClick={send}
            aria-label="Send"
          >
            <Icon name="send" size={16} />
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
            <span className="hide-sm">
              Enter to send · Shift+Enter for a new line · @name to address one agent
            </span>
          )}
        </div>
      </div>
    </>
  );
}

/** Touch-primary devices send with the button, not with the Enter key. */
function isTouch(): boolean {
  return window.matchMedia('(pointer: coarse)').matches;
}

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getDate() === y.getDate() && x.getMonth() === y.getMonth() && x.getFullYear() === y.getFullYear()
  );
}

function MessageRow({
  message,
  lead,
  fresh,
}: {
  message: Message;
  lead: boolean;
  fresh: boolean;
}): JSX.Element {
  const color = avatarColor(message.authorName);
  return (
    <div className={`msg ${lead ? 'lead' : ''} ${fresh ? 'enter' : ''}`}>
      <div className="gutter">
        {lead ? (
          <div className="avatar" style={{ background: color }}>
            {initials(message.authorName)}
          </div>
        ) : (
          <span className="stamp-hover">{clock(message.ts)}</span>
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
            <Icon name="paperclip" size={15} />
            <span>{a.filename}</span>
            <span className="muted">{bytes(a.size)}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
