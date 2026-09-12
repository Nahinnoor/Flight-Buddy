# FlightBuddy — Supabase

Schema, migrations and RLS for FlightBuddy. The authoritative description of the
data model is `docs/PROJECT_OVERVIEW.md` §6 (schema) and §10 (security); this
directory is its implementation.

```
supabase/
├── migrations/         # numbered SQL migrations, applied in filename order
├── (types are generated into packages/shared/src/database.types.ts)
└── README.md
```

## The one rule: never edit an applied migration

**A migration file is immutable the moment it has been applied anywhere.**

The remote dev project and every developer's local database record which
migration versions they have run. Editing an already-applied file does not
re-run it — it just makes the file disagree with the database it supposedly
built, and the next person's `db reset` produces a schema nobody is running.

To change something that a previous migration created, **add a new migration**
that alters it. Fixing a typo in a column name is `alter table … rename column`
in a new file, not a find-and-replace in the old one.

The only moment editing is safe: the migration exists solely on your machine and
has never been applied to the remote project or pushed. If you are unsure,
assume it has been applied.

Name files `YYYYMMDDHHMMSS_<snake_case_name>.sql`, one per logical change.

## Applying migrations locally

Requires the [Supabase CLI](https://supabase.com/docs/guides/local-development)
and a running Docker daemon.

```bash
# one-time: link the repo to the dev project (prompts for the DB password)
supabase link --project-ref <dev-project-ref>

# start the local stack (Postgres, Auth, PostgREST, Studio) on Docker
supabase start

# rebuild the local database from scratch and replay every migration in order.
# This is the command that proves the migrations are self-consistent — run it
# before opening a PR.
supabase db reset

# stop the stack
supabase stop
```

`supabase start` prints the local API URL, Studio URL and local keys. Those
local keys are throwaway values for the Docker stack; the real project keys live
in `.env` and Render environment variables and never get committed.

### Adding a migration

```bash
supabase migration new <snake_case_name>   # creates the timestamped file
$EDITOR supabase/migrations/<timestamp>_<name>.sql
supabase db reset                          # replay everything, including yours
```

### Pushing to the remote project

```bash
supabase migration list   # compare local files against what the remote has run
supabase db push          # apply the migrations the remote has not run yet
```

Write access is for the **dev** project only (§10). Production is read-only for
agents and gets migrations through a reviewed deploy.

## After every migration

Both are binding working rules (§12, rules 11 and 12):

1. **Regenerate types.** They are checked in, so a stale file is a lie the
   compiler believes.

   ```bash
   supabase gen types typescript --linked > packages/shared/src/database.types.ts
   # or, without a link:
   supabase gen types typescript --project-id <dev-project-ref> > packages/shared/src/database.types.ts
   ```

   `packages/shared` re-exports this file; nothing else should import it by path.

2. **Run the advisors** (`get_advisors` over the Supabase MCP, security and
   performance) and resolve every security finding before merging. Missing RLS
   is the one that matters — the data is people's itineraries.

## Conventions this schema relies on

- **RLS is on for every table.** A table with no policies (`notification_deliveries`,
  `provider_credit_log`) is deliberately service-role-only: RLS denies everyone
  else, and the service role bypasses RLS.
- **Policy helpers live in the `private` schema**, are `security definer`, and
  are declared `set search_path = ''` with every reference schema-qualified.
  They exist so a policy on `group_members` can read `group_members` without
  recursing, and so PostgREST never exposes them.
- **`auth.uid()` is always wrapped as `(select auth.uid())`** inside policies and
  helpers, so Postgres evaluates it once per statement instead of once per row.
- **Nothing but the service role writes `flights`.** There is no insert, update
  or delete policy on that table at all — see ADR 0001 and §12 rule 7.
