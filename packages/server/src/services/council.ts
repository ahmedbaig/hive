import { Council, type CouncilVote, ID, K } from '@hive/shared';
import { queueWrite } from '../db.js';
import { broadcast } from '../hub.js';
import { councilVotes } from '../metrics.js';
import { redis } from '../redis.js';
import { createChannel } from './channels.js';
import { postMessage } from './messages.js';

/**
 * A council is a structured debate: participants state opening positions, argue
 * for a bounded number of rounds, then vote. Every turn is an ordinary message
 * in the council's channel tagged `council_turn`, so the normal chat UI and
 * history apply — the Council record only tracks phase, turn order and votes.
 */

export async function openCouncil(input: {
  topic: string;
  question: string;
  options?: string[];
  participants?: string[];
  maxRounds?: number;
  createdBy: string;
}): Promise<Council> {
  const channel = await createChannel({
    name: `council:${input.topic}`.slice(0, 80),
    kind: 'council',
    topic: input.question,
    members: input.participants ?? [],
    createdBy: input.createdBy,
  });

  const council = Council.parse({
    id: ID.council(),
    channelId: channel.id,
    topic: input.topic,
    question: input.question,
    options: input.options ?? [],
    phase: 'gathering',
    participants: input.participants ?? [],
    round: 0,
    maxRounds: input.maxRounds ?? 3,
    votes: [],
    verdict: null,
    createdBy: input.createdBy,
    createdAt: Date.now(),
    closedAt: null,
  });

  await save(council);
  await postMessage(
    {
      channelId: channel.id,
      body: `Council opened: **${input.question}**${
        council.options.length ? `\n\nOptions: ${council.options.join(' · ')}` : ''
      }\n\nMax rounds: ${council.maxRounds}`,
      kind: 'text',
      mentions: ['@all'],
    },
    { type: 'system', id: 'system', name: 'hive' },
  );
  return council;
}

export async function joinCouncil(councilId: string, agentId: string): Promise<Council | null> {
  const council = await getCouncil(councilId);
  if (!council) return null;
  if (council.participants.includes(agentId)) return council;
  const next: Council = { ...council, participants: [...council.participants, agentId] };
  await save(next);
  return next;
}

/**
 * Advance the debate. Phases move gathering → opening → debate → voting →
 * closed; `debate` repeats until maxRounds is spent, at which point the next
 * advance moves to voting rather than looping forever.
 */
export async function advanceCouncil(councilId: string): Promise<Council | null> {
  const council = await getCouncil(councilId);
  if (!council) return null;

  let next: Council;
  switch (council.phase) {
    case 'gathering':
      next = { ...council, phase: 'opening' };
      break;
    case 'opening':
      next = { ...council, phase: 'debate', round: 1 };
      break;
    case 'debate':
      next =
        council.round >= council.maxRounds
          ? { ...council, phase: 'voting' }
          : { ...council, round: council.round + 1 };
      break;
    case 'voting':
      next = { ...council, phase: 'closed', closedAt: Date.now(), verdict: tally(council) };
      break;
    case 'closed':
      return council;
  }

  await save(next);
  await postMessage(
    {
      channelId: next.channelId,
      body:
        next.phase === 'closed'
          ? `Council closed. Verdict: **${next.verdict ?? 'no consensus'}**`
          : `Phase: **${next.phase}**${next.phase === 'debate' ? ` (round ${next.round}/${next.maxRounds})` : ''}`,
      kind: 'text',
      mentions: ['@all'],
    },
    { type: 'system', id: 'system', name: 'hive' },
  );
  return next;
}

export async function speak(input: {
  councilId: string;
  agentId: string;
  agentName: string;
  body: string;
}): Promise<Council | null> {
  const council = await getCouncil(input.councilId);
  if (!council) return null;
  if (council.phase === 'closed') throw new Error('council is closed');

  await postMessage(
    {
      channelId: council.channelId,
      body: input.body,
      kind: 'council_turn',
      meta: { councilId: council.id, phase: council.phase, round: council.round },
    },
    { type: 'agent', id: input.agentId, name: input.agentName },
  );
  return council;
}

export async function castVote(input: {
  councilId: string;
  agentId: string;
  agentName: string;
  option: string;
  rationale?: string;
}): Promise<Council | null> {
  const council = await getCouncil(input.councilId);
  if (!council) return null;
  if (council.phase === 'closed') throw new Error('council is closed');
  if (council.options.length > 0 && !council.options.includes(input.option)) {
    throw new Error(`option must be one of: ${council.options.join(', ')}`);
  }

  const vote: CouncilVote = {
    agentId: input.agentId,
    agentName: input.agentName,
    option: input.option,
    rationale: input.rationale ?? '',
    ts: Date.now(),
  };
  // One vote per agent — a later vote replaces the earlier one.
  const votes = [...council.votes.filter((v) => v.agentId !== input.agentId), vote];
  const next: Council = { ...council, votes };
  await save(next);
  councilVotes.inc({ agent: input.agentId });

  await postMessage(
    {
      channelId: council.channelId,
      body: `votes **${input.option}**${input.rationale ? ` — ${input.rationale}` : ''}`,
      kind: 'council_turn',
      meta: { councilId: council.id, vote: true },
    },
    { type: 'agent', id: input.agentId, name: input.agentName },
  );
  return next;
}

/** Plurality winner. Ties resolve to null so the operator decides. */
function tally(council: Council): string | null {
  if (council.votes.length === 0) return null;
  const counts = new Map<string, number>();
  for (const vote of council.votes) {
    counts.set(vote.option, (counts.get(vote.option) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const runnerUp = ranked[1];
  if (!top) return null;
  if (runnerUp && runnerUp[1] === top[1]) return null;
  return top[0];
}

export async function getCouncil(id: string): Promise<Council | null> {
  const raw = await redis.hget(K.councils, id);
  if (!raw) return null;
  const parsed = Council.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export async function listCouncils(): Promise<Council[]> {
  const all = await redis.hgetall(K.councils);
  const out: Council[] = [];
  for (const raw of Object.values(all)) {
    const parsed = Council.safeParse(JSON.parse(raw));
    if (parsed.success) out.push(parsed.data);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

async function save(council: Council): Promise<void> {
  await redis.hset(K.councils, council.id, JSON.stringify(council));
  broadcast({ t: 'council', council });
  queueWrite(
    `insert into councils (id, channel_id, topic, question, phase, created_at, payload)
     values ($1,$2,$3,$4,$5, to_timestamp($6/1000.0), $7)
     on conflict (id) do update set phase = excluded.phase, payload = excluded.payload`,
    [council.id, council.channelId, council.topic, council.question, council.phase, council.createdAt, council],
  );
}
