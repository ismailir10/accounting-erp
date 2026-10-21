-- Departemen & Proyek on documents (cycle 2026-10-21-departemen-proyek-2). Additive: two nullable columns on Invoice and on
-- AdjustmentSchedule, carried onto the income / expense line of the journals they post.

-- AlterTable
ALTER TABLE "AdjustmentSchedule" ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "projectId" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "projectId" TEXT;

-- AddForeignKey
ALTER TABLE "AdjustmentSchedule" ADD CONSTRAINT "AdjustmentSchedule_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Dimension"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdjustmentSchedule" ADD CONSTRAINT "AdjustmentSchedule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Dimension"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Dimension"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Dimension"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
