-- travelers.created_by had no ON DELETE action (Postgres default NO ACTION), so
-- deleting a profile — and therefore an auth user — was refused whenever the
-- user had created any traveller, which is always (their self-traveller).
-- Account deletion is an App Store requirement (guideline 5.1.1(v)).
--
-- Chosen semantics: SET NULL. Travellers the departing user created for other
-- people survive (an unclaimed traveller still belongs to the group's trip; a
-- traveller someone else has since claimed is that person's data, not the
-- creator's). CASCADE was rejected because it would delete the latter.
-- The RLS policies compare `created_by = auth.uid()`, which is simply false
-- for NULL, so an orphaned unclaimed traveller becomes read-only until
-- Phase 3 reassigns it to the group owner. Inserts still require
-- `created_by = auth.uid()` (travelers_insert_self_or_unclaimed), so the
-- column is only ever NULL as a result of this action.

alter table public.travelers
  alter column created_by drop not null;

alter table public.travelers
  drop constraint travelers_created_by_fkey;

alter table public.travelers
  add constraint travelers_created_by_fkey
    foreign key (created_by) references public.profiles (id) on delete set null;
