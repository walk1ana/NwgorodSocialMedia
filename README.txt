NewGorod — приложение сообщества

Для развёртывания используйте GitHub Pages. Порядок подключения Supabase и описание backend-миграций находятся в `FRIENDS_SETUP.md`.

Для друзей и личных чатов последовательно выполните миграции:
- `supabase/migrations/202611240002_friend_requests.sql`
- `supabase/migrations/202611250001_friend_messages.sql`

Базовая схема пользователей и таблица `public.profiles` должны быть уже настроены.

Не размещайте service_role key, секретные ключи или пароль базы данных в браузерном коде и GitHub.
