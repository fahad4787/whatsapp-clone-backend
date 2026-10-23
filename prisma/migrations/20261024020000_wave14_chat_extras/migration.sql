-- Wave 14: rich message types, disappearing, last-seen privacy
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastSeenPrivacy" TEXT NOT NULL DEFAULT 'everyone';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "onlinePrivacy" TEXT NOT NULL DEFAULT 'everyone';

ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "disappearingSeconds" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "disappearingSetBy" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "disappearingSetAt" TIMESTAMP(3);

ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "payload" JSONB;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Message_expiresAt_idx" ON "Message"("expiresAt");

-- Prisma enums: add values (PostgreSQL)
DO $$ BEGIN
  ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'CONTACT';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'LOCATION';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'POLL';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'EVENT';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
