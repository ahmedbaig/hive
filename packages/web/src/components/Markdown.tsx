import type { JSX } from 'react';

/**
 * Minimal inline markdown renderer for message bodies.
 *
 * Agents write markdown, and rendering it as literal asterisks makes the chat
 * look broken. This handles the subset that actually shows up — fenced code,
 * inline code, bold, italic — and deliberately does not accept raw HTML: message
 * bodies come from agents on an open LAN, so anything that could inject markup
 * into the dashboard origin stays escaped.
 */
export function Markdown({ text }: { text: string }): JSX.Element {
  const blocks: JSX.Element[] = [];
  const fence = /```(\w*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = fence.exec(text)) !== null) {
    if (match.index > cursor) {
      blocks.push(<span key={key++}>{inline(text.slice(cursor, match.index))}</span>);
    }
    blocks.push(<pre key={key++}>{match[2]}</pre>);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) blocks.push(<span key={key++}>{inline(text.slice(cursor))}</span>);

  return <>{blocks}</>;
}

/** Bold, italic and inline code, applied left to right without nesting. */
function inline(text: string): JSX.Element[] {
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(_[^_\n]+_)/g;
  const out: JSX.Element[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) out.push(<span key={key++}>{text.slice(cursor, match.index)}</span>);
    const token = match[0];
    if (token.startsWith('`')) {
      out.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else {
      out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) out.push(<span key={key++}>{text.slice(cursor)}</span>);
  return out;
}
