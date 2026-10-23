-- Wave 13: group admin privacy flags
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "onlyAdminsCanSend" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "onlyAdminsCanEditInfo" BOOLEAN NOT NULL DEFAULT false;
