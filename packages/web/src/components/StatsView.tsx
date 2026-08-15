import type { AgentUsage } from '@hive/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { avatarColor, bytes, compact, duration, initials, percent, relative } from '../format.js';
import { useHive } from '../store.js';
import { Icon } from './Icon.js';

const REFRESH_MS = 15_000;

/**
 * Tokens that represent new work: prompt, completion, and cache writes.
 *
 * Cache *reads* are excluded. They are billed on every request and are real
 * money, but they scale with how long a session has been running rather than
 * with what it did, so including them makes every long session look like a
 * runaway one.
 */
function fresh(window: AgentUsage['window']): number {
  return window.inputTokens + window.outputTokens + window.cacheWriteTokens;
}

/**
 * Fleet usage: context pressure per machine, token spend over the rolling
 * window, and the state of the collected memory corpus.
 *
 * Context is the number that matters operationally — a machine at 90% of its
 * window will do a worse job of the next task than one that just started — so
 * it gets a gauge per agent rather than a line on a chart. Spend is a magnitude
 * over time and gets a sparkline. Neither is a chart with a legend: there is
 * one series per row and the row already names it.
 */
export function StatsView(): JSX.Element {
  const stats = useHive((s) => s.stats);
  const setStats = useHive((s) => s.setStats);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void api
        .stats()
        .then((next) => {
          if (!cancelled) {
            setStats(next);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(String(err));
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [setStats]);

  // The countdown ticks locally between refreshes; the *target* is always the
  // server's timestamp, so no client's clock skew can shift it.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  if (!stats) {
    return (
      <div className="pane">
        {error ? <div className="form-error">{error}</div> : <div className="empty">Loading usage…</div>}
      </div>
    );
  }

  const reset = stats.window.resetsAt;
  const active = stats.agents.filter((a) => a.window.totalTokens > 0);

  return (
    <div className="pane">
      <div className="stat-grid">
        {/*
          Fresh tokens lead, not the grand total. Cache reads are re-charged on
          every request, so on a long session they run to tens of millions and
          swamp everything else — a headline of "80M tokens" says nothing about
          how hard the fleet is actually working. They get their own tile.
        */}
        <Stat
          label={`Fresh tokens · last ${Math.round(stats.window.windowMs / 3_600_000)}h`}
          value={compact(fresh(stats.window))}
          sub={`${stats.window.turns} turns across ${active.length || 0} machines`}
        />
        <Stat
          label="Window resets"
          value={reset === null ? '—' : duration(reset - now)}
          sub={reset === null ? 'no spend recorded yet' : `at ${new Date(reset).toLocaleTimeString()}`}
        />
        <Stat
          label="Cache reads"
          value={compact(stats.window.cacheReadTokens)}
          sub={`${compact(stats.window.outputTokens)} output · re-read each request`}
        />
        <Stat
          label="Memory corpus"
          value={String(stats.memory.files)}
          sub={`${bytes(stats.memory.bytes)} from ${stats.memory.machines} machines`}
        />
      </div>

      {/*
        Said plainly rather than buried in a tooltip. Claude Code does not expose
        rate-limit headers to hooks or MCP tools and this server never calls the
        API, so a countdown to the real billing reset is not derivable. This one
        is measured from first observed spend, which is a different thing.
      */}
      <p className="note">
        <Icon name="clock" size={14} />
        Window is measured from the first request the fleet reported, not from the API&apos;s
        rate-limit headers — Claude Code does not expose those to agents.
        {!stats.durable && ' History is Redis-only until Postgres is reachable.'}
      </p>

      <div className="group-label">Machines</div>
      {stats.agents.length === 0 && <div className="empty">No agents have reported usage yet.</div>}
      {stats.agents.map((agent) => (
        <AgentUsageCard key={agent.agentId} usage={agent} />
      ))}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="stat">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function AgentUsageCard({ usage }: { usage: AgentUsage }): JSX.Element {
  const stats = usage.stats;
  const pct = stats ? percent(stats.contextUsed, stats.contextMax) : 0;
  const level = pct >= 90 ? 'critical' : pct >= 70 ? 'warning' : 'good';

  return (
    <div className="usage-card">
      <div className="usage-head">
        <div
          className="avatar"
          style={{ background: avatarColor(usage.agentName), width: 28, height: 28, fontSize: 11 }}
        >
          {initials(usage.agentName)}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="usage-name">{usage.agentName}</div>
          <div className="usage-sub">
            {stats?.model ?? 'model unknown'}
            {stats ? ` · reported ${relative(stats.updatedAt)}` : ' · no report yet'}
          </div>
        </div>
        <span className="spacer" />
        <Spark values={usage.spark} label={`${usage.agentName} token spend over the window`} />
      </div>

      <div className="gauge-row">
        <div className="gauge">
          {/* Width carries the magnitude; the number beside it carries it again,
              so the status colour is never the only thing saying "nearly full". */}
          <div className={`gauge-fill ${level}`} style={{ width: `${pct}%` }} />
        </div>
        <span className={`gauge-value ${level}`}>{stats ? `${pct}%` : '—'}</span>
      </div>

      <div className="usage-figures">
        <Figure label="context" value={stats ? `${compact(stats.contextUsed)} / ${compact(stats.contextMax)}` : '—'} />
        <Figure label="fresh" value={compact(fresh(usage.window))} />
        <Figure label="output" value={compact(usage.window.outputTokens)} />
        <Figure label="cache read" value={compact(usage.window.cacheReadTokens)} />
        <Figure label="turns" value={String(usage.window.turns)} />
      </div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="figure">
      <span className="figure-value">{value}</span>
      <span className="figure-label">{label}</span>
    </div>
  );
}

/**
 * One row's spend over the window.
 *
 * Bars rather than a line: the series is bucketed counts with real zeros in it,
 * and a line drawn through zeros implies a continuous quantity that dipped,
 * when in fact the machine was simply idle. Single hue — identity comes from
 * the row it sits in, so there is nothing to put in a legend.
 */
function Spark({ values, label }: { values: number[]; label: string }): JSX.Element {
  const max = Math.max(1, ...values);
  const width = 96;
  const height = 24;
  const gap = 1;
  const barWidth = Math.max(1, (width - gap * (values.length - 1)) / values.length);

  return (
    <svg
      className="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      {values.map((value, i) => {
        const h = value === 0 ? 1 : Math.max(2, (value / max) * height);
        return (
          <rect
            key={i}
            x={i * (barWidth + gap)}
            y={height - h}
            width={barWidth}
            height={h}
            rx={barWidth > 3 ? 1.5 : 0}
            className={value === 0 ? 'spark-empty' : 'spark-bar'}
          >
            <title>{`${compact(value)} tokens`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
