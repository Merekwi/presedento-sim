-- Presidential Simulator: military forces, technology, patrols and wars.
-- Additive and idempotent; safe for the existing game database.

ALTER TABLE ministers
  ADD COLUMN IF NOT EXISTS is_candidate BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_ministers_save_candidates
  ON ministers(save_id, is_candidate, portfolio)
  WHERE dismissed_at IS NULL;

ALTER TABLE military_units
  ADD COLUMN IF NOT EXISTS unit_branch TEXT NOT NULL DEFAULT 'land',
  ADD COLUMN IF NOT EXISTS active_personnel INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reserve_personnel INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS equipment_level SMALLINT NOT NULL DEFAULT 35,
  ADD COLUMN IF NOT EXISTS experience SMALLINT NOT NULL DEFAULT 35,
  ADD COLUMN IF NOT EXISTS morale SMALLINT NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_lon DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS operational_status TEXT NOT NULL DEFAULT 'garrison';

CREATE TABLE IF NOT EXISTS military_wars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  save_id UUID NOT NULL REFERENCES game_saves(id) ON DELETE CASCADE,
  opponent_country_id BIGINT REFERENCES countries(id),
  opponent_country_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ceasefire','won','lost')),
  command_mode TEXT NOT NULL DEFAULT 'ai' CHECK (command_mode IN ('ai','manual')),
  strategic_posture TEXT NOT NULL DEFAULT 'defensive' CHECK (strategic_posture IN ('defensive','balanced','offensive')),
  war_goal TEXT NOT NULL DEFAULT 'Ограниченные военные цели',
  turn_number INTEGER NOT NULL DEFAULT 1,
  front_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_report JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_on DATE NOT NULL DEFAULT CURRENT_DATE,
  ended_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS military_technologies (
  save_id UUID NOT NULL REFERENCES game_saves(id) ON DELETE CASCADE,
  tech_id TEXT NOT NULL,
  level SMALLINT NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 5),
  research_points INTEGER NOT NULL DEFAULT 0 CHECK (research_points >= 0),
  is_researching BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (save_id, tech_id)
);

CREATE TABLE IF NOT EXISTS military_patrols (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  save_id UUID NOT NULL REFERENCES game_saves(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES military_units(id) ON DELETE CASCADE,
  patrol_name TEXT NOT NULL DEFAULT 'Патруль',
  patrol_type TEXT NOT NULL DEFAULT 'border' CHECK (patrol_type IN ('border','air','naval','internal')),
  route JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS military_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  war_id UUID NOT NULL REFERENCES military_wars(id) ON DELETE CASCADE,
  unit_id UUID REFERENCES military_units(id) ON DELETE SET NULL,
  order_type TEXT NOT NULL CHECK (order_type IN ('advance','defend','hold','recon','withdraw','support')),
  target_lat DOUBLE PRECISION,
  target_lon DOUBLE PRECISION,
  objective TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','executed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_military_wars_save_status
  ON military_wars(save_id,status,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_military_orders_war_status
  ON military_orders(war_id,status,created_at);
CREATE INDEX IF NOT EXISTS idx_military_patrols_save_status
  ON military_patrols(save_id,status);

-- One-time conversion of old quantity-only formations into a personnel model.
UPDATE military_units
SET unit_branch=CASE
      WHEN unit_type ILIKE '%воздуш%' OR unit_type ILIKE '%авиац%' THEN 'air'
      WHEN unit_type ILIKE '%морск%' OR unit_type ILIKE '%флот%' THEN 'naval'
      WHEN unit_type ILIKE '%гвард%' THEN 'guard'
      ELSE 'land' END,
    active_personnel=CASE
      WHEN unit_type ILIKE '%сухопут%' THEN GREATEST(10000,LEAST(quantity,500000))
      WHEN unit_type ILIKE '%воздуш%' OR unit_type ILIKE '%авиац%' THEN GREATEST(2500,LEAST(quantity*100,120000))
      WHEN unit_type ILIKE '%морск%' OR unit_type ILIKE '%флот%' THEN GREATEST(1500,LEAST(quantity*350,100000))
      ELSE GREATEST(1500,LEAST(quantity,180000)) END,
    reserve_personnel=CASE
      WHEN unit_type ILIKE '%гвард%' THEN GREATEST(1000,LEAST(quantity,150000))
      ELSE GREATEST(1000,LEAST(quantity*2,250000)) END,
    equipment_level=GREATEST(25,LEAST(85,readiness)),
    experience=GREATEST(25,LEAST(85,readiness-4)),
    morale=GREATEST(35,LEAST(90,supply)),
    operational_status='garrison'
WHERE active_personnel=0;
