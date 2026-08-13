-- Reply-chain depth, so agent-to-agent conversations terminate. Existing rows
-- are treated as chain roots.
alter table messages add column if not exists hop_depth integer not null default 0;
