-- Presidential Simulator: continuous in-game calendar and simulation speed.
-- Additive migration for the existing game_saves table; preserves current campaigns.

ALTER TABLE public.game_saves
  ADD COLUMN IF NOT EXISTS game_datetime TIMESTAMP WITHOUT TIME ZONE,
  ADD COLUMN IF NOT EXISTS time_speed INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_simulated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_month_processed DATE,
  ADD COLUMN IF NOT EXISTS calendar_paused BOOLEAN NOT NULL DEFAULT false;

UPDATE public.game_saves
SET game_datetime = COALESCE(game_datetime, game_date::timestamp + INTERVAL '8 hours'),
    last_month_processed = COALESCE(last_month_processed, date_trunc('month', game_date)::date),
    time_speed = CASE
      WHEN time_speed IN (1, 2, 4, 6, 12, 16) THEN time_speed
      ELSE 1
    END
WHERE game_datetime IS NULL
   OR last_month_processed IS NULL
   OR time_speed NOT IN (1, 2, 4, 6, 12, 16);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.game_saves'::regclass
      AND conname = 'game_saves_time_speed_check'
  ) THEN
    ALTER TABLE public.game_saves
      ADD CONSTRAINT game_saves_time_speed_check
      CHECK (time_speed IN (1, 2, 4, 6, 12, 16));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_game_saves_active_clock
  ON public.game_saves(status, calendar_paused, last_simulated_at)
  WHERE status = 'active';
