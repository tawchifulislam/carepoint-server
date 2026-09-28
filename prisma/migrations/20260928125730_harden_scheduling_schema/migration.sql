/*
  Warnings:

  - A unique constraint covering the columns `[doctorId,date]` on the table `availability_exceptions` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "availability_exceptions_doctorId_idx";

-- AlterTable
ALTER TABLE "availability_exceptions" ALTER COLUMN "date" SET DATA TYPE DATE;

-- CreateIndex
CREATE UNIQUE INDEX "availability_exceptions_doctorId_date_key" ON "availability_exceptions"("doctorId", "date");

-- CreateIndex
CREATE INDEX "doctors_approvalStatus_specialty_idx" ON "doctors"("approvalStatus", "specialty");
