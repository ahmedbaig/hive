import { AgentCommand, type CommandKind, ID, K } from '@hive/shared';
import { sendToAgent } from '../hub.js';
import { log } from '../log.js';
import { commandsIssued } from '../metrics.js';
import { redis } from '../redis.js';

/**
 * Commands reach a daemon two ways: pushed over its WebSocket if attached, and
 * queued in Redis regardless. The queue is what makes a command survive a
 * daemon restart — it drains the list on reconnect before going live.
 */
export async function issueCommand(input: {
  agentId: string;
  kind: CommandKind;
  payload?: string;
  issuedBy: string;
  replyChannelId?: string | null;
}): Promise<AgentCommand> {
  const command = AgentCommand.parse({
    id: ID.task(),
    kind: input.kind,
    ts: Date.now(),
    issuedBy: input.issuedBy,
    payload: input.payload ?? '',
    replyChannelId: input.replyChannelId ?? null,
  });

  await redis.rpush(K.commandQueue(input.agentId), JSON.stringify(command));
  // Bounded so an offline machine does not accumulate a week of instructions.
  await redis.ltrim(K.commandQueue(input.agentId), -100, -1);
  await redis.expire(K.commandQueue(input.agentId), 86_400);

  const delivered = sendToAgent(input.agentId, { t: 'command', command });
  commandsIssued.inc({
    agent: input.agentId,
    kind: command.kind,
    delivery: delivered ? 'pushed' : 'queued',
  });
  log.info(
    { agentId: input.agentId, kind: command.kind, delivered },
    delivered ? 'command pushed' : 'command queued for offline agent',
  );
  return command;
}

/** Drain everything queued for an agent. Called by the daemon on connect. */
export async function drainCommands(agentId: string): Promise<AgentCommand[]> {
  const raws = await redis.lrange(K.commandQueue(agentId), 0, -1);
  if (raws.length === 0) return [];
  await redis.del(K.commandQueue(agentId));
  const out: AgentCommand[] = [];
  for (const raw of raws) {
    const parsed = AgentCommand.safeParse(JSON.parse(raw));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
