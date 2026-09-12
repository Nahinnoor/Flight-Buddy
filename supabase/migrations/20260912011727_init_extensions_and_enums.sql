-- Foundational objects for FlightBuddy: extensions, the private helper schema,
-- and the shared enums from PROJECT_OVERVIEW.md §6.2.

-- citext backs case-insensitive email columns (profiles.email, travelers.invite_email).
create extension if not exists citext with schema extensions;
-- pgcrypto is already present on Supabase; declared here so a fresh local
-- `supabase db reset` produces the same database.
create extension if not exists pgcrypto with schema extensions;

-- RLS helper functions live in `private` so PostgREST never exposes them and so
-- security-definer checks can read group_members without recursive RLS.
create schema if not exists private;
grant usage on schema private to anon, authenticated, service_role;

create type public.tracking_tier as enum ('live', 'scheduled', 'manual');

create type public.flight_status as enum (
  'scheduled', 'delayed', 'boarding', 'departed',
  'en_route', 'diverted', 'landed', 'cancelled', 'unknown'
);

create type public.membership_status as enum ('pending', 'active', 'removed');
