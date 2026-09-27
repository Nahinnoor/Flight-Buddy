-- Phase 2, wave 5 (app side): a device's push token belongs to at most one
-- account (overview §9, §10; PHASE2_PLAN criterion 6).
--
-- The problem. `profiles.expo_push_token` is one column per profile, and the app
-- used to write it with a plain `update … where id = me`. Nothing removed it
-- from anyone else. So when user A signed out (or deleted the app without
-- signing out) and user B later signed in on the same phone, both profiles held
-- that phone's token, and the worker delivered A's flight alerts — flight
-- number, route, gate, times — to B's lock screen.
--
-- The fix has three parts, all here:
--
-- 1. `public.register_push_token(p_token)` — the app's only write path for its
--    own token. It sets the token on the caller's profile and nulls it on
--    every other profile that holds it, in one transaction. RLS cannot express
--    "remove this value from rows you cannot see", so it is `security definer`.
--
-- 2. `public.unregister_push_token(p_token)` — called on sign-out, while the
--    session still exists. Clears the caller's own token only if it still is
--    this device's token, so a newer registration from another phone survives.
--    `security invoker`: it runs under the caller's own RLS, which already
--    allows exactly this. It exists (rather than a PostgREST `update … eq`)
--    so the token travels in a POST body, never in a URL query string that
--    request logs record.
--
-- 3. A partial unique index on the column, so the invariant holds whatever the
--    write path — including an older app build still doing the direct update,
--    which now fails instead of creating a second holder.
--
-- Why `register_push_token` is safe to expose:
--   * It only ever SETS the token on `auth.uid()`'s own row, and only ever sets
--     it to NULL on other rows. It never copies a value from another row, and
--     it returns nothing, so it cannot be used to read anyone's token or learn
--     whether a token is registered to someone else.
--   * It cannot move someone else's alerts to the caller: pushes go to the
--     device a token identifies, not to whoever holds the row. Holding a token
--     only means "my flights' alerts go to that device".
--   * Residual risk, accepted: a caller who already knows another device's
--     token (a bearer secret — never logged, never shown, only readable by the
--     account holding it and the worker) could register it to themselves and
--     so stop the other account's alerts until that device next registers
--     (every app launch). Knowing a token needs access to the device or the
--     worker; before this migration the same caller could already point their
--     own alerts at that device.
--   * `set search_path = ''`, fully qualified names, token shape validated
--     before use, and EXECUTE only for `authenticated`.
--
-- Existing duplicates: any token held by more than one profile is cleared on
-- every holder before the unique index is built. It cannot be known which
-- holder is the device's current user, and a wrong guess is exactly the leak
-- this fixes; each device re-registers on its next launch.

-- ------------------------------------------------------------ duplicates --

update public.profiles
   set expo_push_token = null
 where expo_push_token in (
         select expo_push_token
           from public.profiles
          where expo_push_token is not null
          group by expo_push_token
         having count(*) > 1
       );

create unique index profiles_expo_push_token_key
  on public.profiles (expo_push_token)
  where expo_push_token is not null;

-- ------------------------------------------------------------- register --

create or replace function public.register_push_token(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  -- Same shape the worker accepts (services/poller/src/push/tokens.ts). The
  -- value is never echoed back in the error.
  if p_token is null
     or p_token !~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{1,200}\]$' then
    raise exception 'invalid push token' using errcode = '22023';
  end if;

  -- Two accounts registering the same device at once (a sign-out and sign-in
  -- racing on one phone) take turns, instead of one failing on the unique index.
  perform pg_advisory_xact_lock(hashtextextended(p_token, 0));

  update public.profiles
     set expo_push_token = null
   where expo_push_token = p_token
     and id <> v_uid;

  update public.profiles
     set expo_push_token = p_token
   where id = v_uid
     and expo_push_token is distinct from p_token;
end;
$$;

comment on function public.register_push_token(text) is
  'Sets the caller''s push token and removes it from every other profile. Returns nothing.';

revoke all on function public.register_push_token(text) from public, anon;
grant execute on function public.register_push_token(text) to authenticated;

-- ----------------------------------------------------------- unregister --

create or replace function public.unregister_push_token(p_token text)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.profiles
     set expo_push_token = null
   where id = (select auth.uid())
     and expo_push_token = p_token;
$$;

comment on function public.unregister_push_token(text) is
  'Clears the caller''s push token if it still equals p_token. Returns nothing.';

revoke all on function public.unregister_push_token(text) from public, anon;
grant execute on function public.unregister_push_token(text) to authenticated;
