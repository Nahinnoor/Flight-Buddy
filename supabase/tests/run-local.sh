#!/usr/bin/env bash
# Replays every migration into a throwaway local Postgres, then runs the SQL
# contract tests in this directory. Needs `initdb`, `pg_ctl` and `psql` on PATH
# (Homebrew `postgresql@14` or newer). No Docker, no network, no project keys:
# the cluster lives in a temp directory, listens only on a Unix socket, and is
# deleted on exit.
#
# Supabase provides a few things the migrations assume; they are stubbed with
# the smallest faithful equivalent:
#   * roles anon / authenticated / service_role, and Supabase's default grants
#     (every new table and function in `public` is granted to all three — which
#     is why a migration must `revoke … from public, anon` explicitly);
#   * `auth.users` (only the columns `handle_new_user` reads) and `auth.uid()`,
#     defined as Supabase defines it: the `sub` of the request's JWT claims.
#
# Usage: supabase/tests/run-local.sh [test.sql ...]   (default: every *.test.sql)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
migrations="${MIGRATIONS_DIR:-$here/../migrations}"
work="$(mktemp -d)"
port=54329

cleanup() {
  pg_ctl -D "$work/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

initdb -D "$work/data" -U postgres --auth=trust >/dev/null
pg_ctl -D "$work/data" -o "-k $work -p $port -c listen_addresses=''" -l "$work/log" -w start >/dev/null

run() { psql -X -q -v ON_ERROR_STOP=1 -h "$work" -p "$port" -U postgres -d postgres "$@"; }

run <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;
SQL

for file in "$migrations"/*.sql; do
  echo "migrate $(basename "$file")"
  run -f "$file" >/dev/null
done

if [ "$#" -eq 0 ]; then set -- "$here"/*.test.sql; fi
for test in "$@"; do
  echo "test    $(basename "$test")"
  run -f "$test" >/dev/null
done
