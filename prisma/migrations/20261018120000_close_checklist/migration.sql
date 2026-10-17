-- Checklist tutup buku (docs/cycles/2026-10-17-checklist-tutup-buku.md). Additive: one enum and two new tables; no existing column changes.
-- A client's template of tasks (Pelaksana, optional Pereviu, due day, the months it applies to) and the sparse per-month marks of its
-- human tasks. Otomatis tasks are read from the books and never stored per month; a Pemeriksaan akhir's Selesai stays the CloseSignoff row.

-- CreateEnum
CREATE TYPE "ChecklistKind" AS ENUM ('AUTO', 'SIGNOFF', 'MANUAL');

-- CreateTable
CREATE TABLE "ChecklistTask" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" "ChecklistKind" NOT NULL,
    "key" TEXT,
    "title" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "assigneeId" TEXT NOT NULL,
    "reviewerId" TEXT,
    "dueDay" INTEGER NOT NULL,
    "startPeriod" INTEGER NOT NULL,
    "endPeriod" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChecklistTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistMark" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "kind" "ChecklistKind" NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "doneAt" TIMESTAMP(3),
    "doneById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,

    CONSTRAINT "ChecklistMark_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChecklistTask_clientId_idx" ON "ChecklistTask"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistTask_id_kind_key" ON "ChecklistTask"("id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistMark_taskId_year_month_key" ON "ChecklistMark"("taskId", "year", "month");

-- AddForeignKey
ALTER TABLE "ChecklistTask" ADD CONSTRAINT "ChecklistTask_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistTask" ADD CONSTRAINT "ChecklistTask_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "FirmMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistTask" ADD CONSTRAINT "ChecklistTask_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "FirmMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistMark" ADD CONSTRAINT "ChecklistMark_taskId_kind_fkey" FOREIGN KEY ("taskId", "kind") REFERENCES "ChecklistTask"("id", "kind") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistMark" ADD CONSTRAINT "ChecklistMark_doneById_fkey" FOREIGN KEY ("doneById") REFERENCES "FirmMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistMark" ADD CONSTRAINT "ChecklistMark_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "FirmMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The template's invariants: due day 1–28 of the month after the period; YYYYMM months, the end not before the start; a MANUAL task has no
-- key and the others have one; an Otomatis task is never reviewed; the Pereviu is never the Pelaksana; a title is never blank.
ALTER TABLE "ChecklistTask" ADD CONSTRAINT "ChecklistTask_dueDay_check" CHECK ("dueDay" BETWEEN 1 AND 28);
ALTER TABLE "ChecklistTask" ADD CONSTRAINT "ChecklistTask_period_check" CHECK (
  "startPeriod" BETWEEN 190001 AND 219912 AND "startPeriod" % 100 BETWEEN 1 AND 12
  AND ("endPeriod" IS NULL OR ("endPeriod" >= "startPeriod" AND "endPeriod" <= 219912 AND "endPeriod" % 100 BETWEEN 1 AND 12))
);
ALTER TABLE "ChecklistTask" ADD CONSTRAINT "ChecklistTask_key_check" CHECK (("kind" = 'MANUAL') = ("key" IS NULL));
ALTER TABLE "ChecklistTask" ADD CONSTRAINT "ChecklistTask_reviewer_check" CHECK (
  ("kind" <> 'AUTO' OR "reviewerId" IS NULL) AND ("reviewerId" IS NULL OR "reviewerId" <> "assigneeId")
);
ALTER TABLE "ChecklistTask" ADD CONSTRAINT "ChecklistTask_title_check" CHECK (length(btrim("title")) > 0);

-- The marks' invariants: never for an Otomatis task; a Pemeriksaan akhir's mark holds only its review (Selesai is the CloseSignoff row);
-- a Manual review only with a tick; who and when go together; a row exists only with a tick or a review.
ALTER TABLE "ChecklistMark" ADD CONSTRAINT "ChecklistMark_kind_check" CHECK (
  "kind" <> 'AUTO'
  AND ("kind" <> 'SIGNOFF' OR "doneAt" IS NULL)
  AND ("kind" <> 'MANUAL' OR "reviewedAt" IS NULL OR "doneAt" IS NOT NULL)
);
ALTER TABLE "ChecklistMark" ADD CONSTRAINT "ChecklistMark_pairs_check" CHECK (
  ("doneAt" IS NULL) = ("doneById" IS NULL) AND ("reviewedAt" IS NULL) = ("reviewedById" IS NULL)
  AND ("doneAt" IS NOT NULL OR "reviewedAt" IS NOT NULL)
);
ALTER TABLE "ChecklistMark" ADD CONSTRAINT "ChecklistMark_month_check" CHECK ("month" BETWEEN 1 AND 12);
