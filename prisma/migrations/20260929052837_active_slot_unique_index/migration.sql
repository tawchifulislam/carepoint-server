-- DropIndex
DROP INDEX "appointments_doctorId_slotStart_key";

-- CreateIndex
CREATE INDEX "appointments_status_reminderSentAt_slotStart_idx" ON "appointments"("status", "reminderSentAt", "slotStart");

-- CreateIndex
CREATE INDEX "appointments_doctorId_status_idx" ON "appointments"("doctorId", "status");

CREATE UNIQUE INDEX "appointments_active_slot_unique" ON "appointments"("doctorId", "slotStart")
WHERE "status" IN ('PENDING_PAYMENT', 'BOOKED', 'COMPLETED');
