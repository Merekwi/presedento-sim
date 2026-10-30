# Presidential Simulator

Браузерный симулятор президента случайной страны. Статический интерфейс размещается на GitHub Pages, API — на Cloudflare Workers, состояние игры — в Neon PostgreSQL, генерация официальных документов — через OpenRouter.

## Файлы
- `frontend/` — интерфейс сайта
- `worker/` — серверный API-шаблон
- `database/` — описание схемы Neon

## Развёртывание
1. GitHub → Settings → Pages → Deploy from a branch → `main` → `/frontend`.
2. Разверните `worker/` в Cloudflare Workers.
3. Добавьте Worker secrets: `DATABASE_URL`, `OPENROUTER_API_KEY`.
4. Задайте переменные `OPENROUTER_MODEL` (доступный сейчас бесплатный slug) и `ALLOWED_ORIGIN` (адрес GitHub Pages).
5. В `frontend/config.js` укажите адрес Worker.

**Важно:** до добавления авторизации не открывайте API для публичного сохранения игровых данных. Не помещайте секреты в frontend или GitHub.
