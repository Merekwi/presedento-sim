-- Presidential Simulator: Telegram identities, persistent sessions and campaign bootstrap.
-- Safe to apply to the current project; existing tables and records are preserved.

CREATE TABLE IF NOT EXISTS game_users (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL UNIQUE,
  telegram_username TEXT,
  first_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE game_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS game_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES game_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_game_sessions_expiry ON game_sessions(expires_at);

CREATE TABLE IF NOT EXISTS telegram_login_codes (
  id BIGSERIAL PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id BIGINT REFERENCES game_users(id) ON DELETE CASCADE,
  session_token TEXT,
  state_hash TEXT,
  telegram_id BIGINT,
  telegram_username TEXT,
  first_name TEXT
);
ALTER TABLE telegram_login_codes ADD COLUMN IF NOT EXISTS state_hash TEXT;
ALTER TABLE telegram_login_codes ADD COLUMN IF NOT EXISTS telegram_id BIGINT;
ALTER TABLE telegram_login_codes ADD COLUMN IF NOT EXISTS telegram_username TEXT;
ALTER TABLE telegram_login_codes ADD COLUMN IF NOT EXISTS first_name TEXT;
CREATE INDEX IF NOT EXISTS idx_telegram_login_codes_expiry ON telegram_login_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_login_state_code ON telegram_login_codes(state_hash, expires_at);

ALTER TABLE game_saves ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE countries ADD COLUMN IF NOT EXISTS flag_emoji TEXT;
ALTER TABLE countries ADD COLUMN IF NOT EXISTS baseline_state JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE decrees ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';
ALTER TABLE decrees ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES game_users(id) ON DELETE SET NULL,
  save_id UUID REFERENCES game_saves(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_game_saves_owner ON game_saves(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_decrees_save_status ON decrees(save_id, status, created_at DESC);

INSERT INTO countries(iso2,name_en,name_local,government_type,region,flag_emoji,baseline_state)
VALUES
  ('PL', 'Poland', 'Республика Польша', 'Парламентская республика', 'Европа', '🇵🇱', '{"gdp":820,"gdpGrowth":2.4,"inflation":4.1,"unemployment":3.2,"budgetBalance":-2.8,"treasury":46,"population":37.6,"militaryPower":58,"debt":49,"taxRate":23}'::jsonb),
  ('CL', 'Chile', 'Республика Чили', 'Президентская республика', 'Южная Америка', '🇨🇱', '{"gdp":335,"gdpGrowth":2,"inflation":3.8,"unemployment":8.4,"budgetBalance":-1.7,"treasury":22,"population":19.7,"militaryPower":38,"debt":39,"taxRate":21}'::jsonb),
  ('ID', 'Indonesia', 'Республика Индонезия', 'Президентская республика', 'Азия', '🇮🇩', '{"gdp":1400,"gdpGrowth":5,"inflation":2.8,"unemployment":5,"budgetBalance":-2.2,"treasury":62,"population":278,"militaryPower":55,"debt":39,"taxRate":11}'::jsonb),
  ('BR', 'Brazil', 'Федеративная Республика Бразилия', 'Федеративная президентская республика', 'Южная Америка', '🇧🇷', '{"gdp":2180,"gdpGrowth":2.1,"inflation":4.5,"unemployment":7.1,"budgetBalance":-6,"treasury":52,"population":212,"militaryPower":62,"debt":76,"taxRate":31}'::jsonb),
  ('NL', 'Netherlands', 'Королевство Нидерландов', 'Парламентская конституционная монархия', 'Европа', '🇳🇱', '{"gdp":1150,"gdpGrowth":1.5,"inflation":3.2,"unemployment":3.7,"budgetBalance":-1.1,"treasury":75,"population":17.9,"militaryPower":36,"debt":43,"taxRate":26}'::jsonb),
  ('JP', 'Japan', 'Япония', 'Парламентская конституционная монархия', 'Азия', '🇯🇵', '{"gdp":4200,"gdpGrowth":0.8,"inflation":2.7,"unemployment":2.6,"budgetBalance":-4.5,"treasury":90,"population":123,"militaryPower":76,"debt":250,"taxRate":28}'::jsonb),
  ('CA', 'Canada', 'Канада', 'Федеративная парламентская демократия', 'Северная Америка', '🇨🇦', '{"gdp":2150,"gdpGrowth":1.7,"inflation":2.8,"unemployment":6.2,"budgetBalance":-1.5,"treasury":80,"population":41,"militaryPower":51,"debt":107,"taxRate":25}'::jsonb),
  ('TR', 'Turkey', 'Турецкая Республика', 'Президентская республика', 'Европа и Азия', '🇹🇷', '{"gdp":1340,"gdpGrowth":3.1,"inflation":35,"unemployment":8.5,"budgetBalance":-4.7,"treasury":19,"population":85.7,"militaryPower":73,"debt":29,"taxRate":23}'::jsonb),
  ('IN', 'India', 'Республика Индия', 'Федеративная парламентская республика', 'Азия', '🇮🇳', '{"gdp":3900,"gdpGrowth":6.5,"inflation":4.8,"unemployment":7.5,"budgetBalance":-5.6,"treasury":70,"population":1428,"militaryPower":82,"debt":83,"taxRate":18}'::jsonb),
  ('ZA', 'South Africa', 'Южно-Африканская Республика', 'Парламентская республика', 'Африка', '🇿🇦', '{"gdp":405,"gdpGrowth":1.2,"inflation":5.1,"unemployment":32,"budgetBalance":-4.8,"treasury":14,"population":63,"militaryPower":31,"debt":75,"taxRate":27}'::jsonb),
  ('AU', 'Australia', 'Австралийский Союз', 'Федеративная парламентская монархия', 'Океания', '🇦🇺', '{"gdp":1700,"gdpGrowth":1.9,"inflation":3.4,"unemployment":4.1,"budgetBalance":-1.2,"treasury":80,"population":27,"militaryPower":49,"debt":51,"taxRate":24}'::jsonb),
  ('MX', 'Mexico', 'Мексиканские Соединенные Штаты', 'Федеративная президентская республика', 'Северная Америка', '🇲🇽', '{"gdp":1800,"gdpGrowth":2,"inflation":4.4,"unemployment":2.8,"budgetBalance":-4,"treasury":30,"population":130,"militaryPower":42,"debt":58,"taxRate":17}'::jsonb),
  ('DE', 'Germany', 'Федеративная Республика Германия', 'Федеративная парламентская республика', 'Европа', '🇩🇪', '{"gdp":4500,"gdpGrowth":0.4,"inflation":2.5,"unemployment":3.4,"budgetBalance":-2,"treasury":105,"population":84.5,"militaryPower":62,"debt":64,"taxRate":29}'::jsonb),
  ('FR', 'France', 'Французская Республика', 'Полупрезидентская республика', 'Европа', '🇫🇷', '{"gdp":3100,"gdpGrowth":1,"inflation":2.8,"unemployment":7.4,"budgetBalance":-5.5,"treasury":72,"population":68,"militaryPower":67,"debt":112,"taxRate":31}'::jsonb),
  ('EG', 'Egypt', 'Арабская Республика Египет', 'Президентская республика', 'Африка', '🇪🇬', '{"gdp":395,"gdpGrowth":3.5,"inflation":25,"unemployment":7,"budgetBalance":-6,"treasury":11,"population":114,"militaryPower":71,"debt":90,"taxRate":15}'::jsonb),
  ('AR', 'Argentina', 'Аргентинская Республика', 'Президентская республика', 'Южная Америка', '🇦🇷', '{"gdp":640,"gdpGrowth":1.4,"inflation":80,"unemployment":7.5,"budgetBalance":-2.5,"treasury":13,"population":46,"militaryPower":29,"debt":85,"taxRate":27}'::jsonb),
  ('TH', 'Thailand', 'Королевство Таиланд', 'Конституционная монархия', 'Азия', '🇹🇭', '{"gdp":545,"gdpGrowth":2.7,"inflation":1.2,"unemployment":1.1,"budgetBalance":-2,"treasury":18,"population":72,"militaryPower":46,"debt":62,"taxRate":17}'::jsonb),
  ('NO', 'Norway', 'Королевство Норвегия', 'Парламентская конституционная монархия', 'Европа', '🇳🇴', '{"gdp":580,"gdpGrowth":1.7,"inflation":3,"unemployment":3.8,"budgetBalance":8,"treasury":210,"population":5.6,"militaryPower":47,"debt":43,"taxRate":30}'::jsonb),
  ('KE', 'Kenya', 'Республика Кения', 'Президентская республика', 'Африка', '🇰🇪', '{"gdp":115,"gdpGrowth":5,"inflation":6.5,"unemployment":5.7,"budgetBalance":-5.2,"treasury":5,"population":55,"militaryPower":25,"debt":68,"taxRate":16}'::jsonb),
  ('UA', 'Ukraine', 'Украина', 'Полупрезидентская республика', 'Европа', '🇺🇦', '{"gdp":190,"gdpGrowth":3,"inflation":7,"unemployment":14,"budgetBalance":-15,"treasury":7,"population":37,"militaryPower":70,"debt":95,"taxRate":20}'::jsonb)
ON CONFLICT(iso2) DO UPDATE SET
  name_en=EXCLUDED.name_en,
  name_local=EXCLUDED.name_local,
  government_type=EXCLUDED.government_type,
  region=EXCLUDED.region,
  flag_emoji=EXCLUDED.flag_emoji,
  baseline_state=EXCLUDED.baseline_state;
