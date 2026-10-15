#!/usr/bin/env bash
# Vercel build (runs instead of `npm run build` because package.json has "vercel-build").
# A build never writes to the database or to Auth: it checks that the schema is current, then builds. Applying a migration, the first
# firm and admin, and demo data are deliberate operator steps (README → Deploy; ADR 0019), never side effects of a deploy.
set -euo pipefail

# The Supabase ↔ Vercel integration injects POSTGRES_PRISMA_URL (pooled) and POSTGRES_URL_NON_POOLING (direct).
# They win over a leftover DATABASE_URL from an older database integration.
export DATABASE_URL="${POSTGRES_PRISMA_URL:-${POSTGRES_URL:-${DATABASE_URL:-}}}"
DIRECT_URL="${POSTGRES_URL_NON_POOLING:-${DIRECT_URL:-$DATABASE_URL}}"
if [ -z "$DATABASE_URL" ]; then
  echo "✗ No database URL. Connect the Supabase project to this Vercel project (Integrations → Supabase) and redeploy." >&2
  exit 1
fi

npx prisma generate

# Read-only: fails the build while a migration in prisma/migrations is not recorded as applied, or is recorded as failed, so code never
# ships ahead of its schema. It does not detect drift: an unknown extra applied migration, an edited migration file or a hand-changed
# table all still read "up to date" (ADR 0019). A build never applies migrations; apply them first with `npm run db:migrate`.
if ! DATABASE_URL="$DIRECT_URL" npx prisma migrate status; then
  echo "✗ The database schema is not current. Apply the pending migrations with \`npm run db:migrate\` (README → Schema changes), then redeploy." >&2
  exit 1
fi

npx next build
