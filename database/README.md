# Neon database

Dedicated Neon project: `presidential-simulator` (PostgreSQL 16), main branch.

Current schema includes countries, game users and sessions, one-time Telegram login codes, game saves, decrees, ministers, diplomatic relations, military units, game events and audit log.

Apply migrations in order from `database/migrations/`. Migration `002-auth-and-sim-systems.sql` documents the Telegram identity/session tables, safe additive columns, audit log and the initial 20-country catalogue. It uses `IF NOT EXISTS` and `ON CONFLICT` so it can be re-applied without deleting saved data.

The application server uses a restricted `presidentapi` database role. Never put its connection string or any other credentials in this folder, Git history or frontend code.
