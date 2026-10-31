# Presidential AI Engine

Additional AI endpoints for the existing Presidential Simulator. This is deployed as a separate Neon Function so the current `nettleapi` function and Telegram authentication flow remain untouched.

## Routes

- `GET /api/presidential/ai/health` — database readiness, no credentials exposed.
- `POST /api/presidential/ai/decree/draft` and `/publish` — AI legal drafting plus validated, server-applied state deltas.
- `POST /api/presidential/ai/election/decision` — free-text policy proposals for the current campaign issue.
- `POST /api/presidential/ai/election/action` — interpret free-form campaign/political actions, including corruption and attempted institutional seizure/coup. Coup outcomes are resolved by server-side odds, not by the model.
- `GET /api/presidential/ai/diplomacy/history?relationId=...` and `POST /api/presidential/ai/diplomacy/message` — persistent free-text negotiations with a foreign leader.

All mutating routes require the existing bearer session. The session is SHA-256 hashed and joined to the user and their active save in the existing database. The model never receives credentials and cannot run SQL. The server validates all proposed metrics against whitelists and clamps them before writing.

## Environment

- `PRESIDENTIAL_DATABASE_URL` — restricted `presidentapi` role connection to the game database.
- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL` (optional; defaults to `openai/gpt-4o-mini`)
- `PRESIDENTIAL_GAME_ORIGIN=https://merekwi.github.io`
