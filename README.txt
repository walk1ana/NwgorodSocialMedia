NewGorod — приложение сообщества

Для развёртывания используйте GitHub Pages. Порядок подключения Supabase и описание backend-миграций находятся в папке supabase/.

Чтобы включить полноценную взаимную дружбу, обязательно выполните файл:
supabase/migrations/202611240002_friend_requests.sql

Инструкция: supabase/FRIENDS_SETUP.md

Не размещайте service_role key, секретные ключи или пароль базы данных в браузерном коде и GitHub.
