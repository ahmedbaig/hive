-- Model turns per report.
--
-- Without this the window's turn count was really a count of *reports*, which
-- is one per Stop hook, not one per turn — a session that ran twelve turns
-- between two Stops counted as one. Defaulted to 1 so existing rows keep the
-- meaning they were written with.
alter table token_events add column if not exists turns integer not null default 1;
