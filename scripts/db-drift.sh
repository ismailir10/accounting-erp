#!/usr/bin/env bash
# Read-only drift check of the database at DATABASE_URL against this checkout (ADR 0019, amended): the applied migration history must
# match prisma/migrations (no unknown migration, no edited file) and the live tables must match prisma/schema.prisma. Triggers and
# CHECK constraints are not modelled by `prisma migrate diff`; an edited migration that touched them is still caught by the history.
# Run by scripts/vercel-build.sh on the direct URL, by CI on a freshly migrated database, and by hand: `npm run db:drift`.
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/migration-history.mjs

set +e
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
diff_exit=$?
set -e
if [ "$diff_exit" -eq 2 ]; then
  echo "✗ The database tables differ from prisma/schema.prisma (listed above). Someone changed the database by hand, or the schema changed without a migration." >&2
  exit 2
elif [ "$diff_exit" -ne 0 ]; then
  echo "✗ Could not compare the database with prisma/schema.prisma." >&2
  exit 1
fi
echo "✓ Database tables match prisma/schema.prisma."
