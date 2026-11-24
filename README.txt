NewGorod — приложение сообщества

Для развёртывания используйте GitHub Pages. Порядок подключения Supabase и описание backend-миграций находятся в `FRIENDS_SETUP.md`.

Порядок миграций для нового Supabase-проекта:
- `supabase/migrations/202611240001_initial_schema.sql`
- `supabase/migrations/202611240002_friend_requests.sql`
- `supabase/migrations/202611250001_friend_messages.sql`

Для уже настроенной базы применяйте только миграции, которых ещё нет в удалённой истории. Не запускайте базовую миграцию повторно, если она уже применена.

Не размещайте service_role key, секретные ключи или пароль базы данных в браузерном коде и GitHub.
