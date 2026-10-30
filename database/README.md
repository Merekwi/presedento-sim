# Neon database

Dedicated Neon project: `presidential-simulator` (PostgreSQL 16).

Initial schema has been created directly in Neon:
- `countries`
- `game_saves`
- `decrees`
- `ministers`
- `diplomatic_relations`
- `military_units`
- `game_events`

Credentials must only be stored as Cloudflare Worker secrets. The next milestone is authentication, save ownership, transactional game turns, and persisting published decrees.
