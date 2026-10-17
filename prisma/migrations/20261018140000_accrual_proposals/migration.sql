-- Usulan akrual (cycle 2026-10-18-usulan-akrual): accruals proposed from each vendor's history are computed at read time and stored
-- only when decided, as a ProposedEntry (POSTED with its entry, or DISMISSED for the month), as the 1999 corrections are. Additive,
-- no backfill. Postgres does not allow a value added by ALTER TYPE … ADD VALUE to be used in the transaction that adds it: nothing
-- here uses it.

-- AlterEnum
ALTER TYPE "ProposalSource" ADD VALUE 'ACCRUAL';
