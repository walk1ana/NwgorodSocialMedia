# NewGorod — backend foundation

## Current milestone
This package adds the first Supabase database migration for NewGorod:
profiles, posts, comments, likes, follows, stories, conversations, members,
messages, notifications, reports, blocks, moderation audit log, RLS policies,
storage buckets and Realtime publication entries.

## Apply the migration
1. Open the Supabase project already referenced in `auth.js`.
2. Open **SQL Editor** → **New query**.
3. Open `supabase/migrations/202611240001_initial_schema.sql`.
4. Copy the complete SQL into the editor and run it.
5. Check that the query finishes without errors.
6. In **Authentication → URL Configuration**, add the exact GitHub Pages URL
   to Site URL / Redirect URLs as appropriate.
7. In **Database → Replication**, verify Realtime is enabled for `posts`,
   `messages` and `notifications` (the migration also attempts to add them).

## Security notes
- `auth.js` contains a publishable client key. This is expected for browser apps.
- Never paste a `service_role`, secret, database password, or recovery code into
  `auth.js`, GitHub, issues, or chat.
- Moderator access is checked using `app_metadata.role` set only by trusted
  server-side administration. Do not set moderator roles from a browser.
- Public media buckets are readable by anyone. Do not upload private images.
- The schema is the backend foundation; the existing app UI is not yet wired
  to all these tables. Do not treat the network feed/chat/moderation as live
  until the next integration milestone and end-to-end tests are complete.

## Important follow-up before public launch
The first migration intentionally establishes the schema and access boundary.
Before launch, add rate limiting/anti-spam, moderation workflows, message abuse
reporting, account deletion/export, backups, monitoring, and security tests.
Review the policies against the final product requirements. For production
direct messages with strong confidentiality requirements, implement and audit
a real end-to-end encryption protocol separately.
