-- Wave 25: stickers (message type) + chat lock

ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'STICKER';

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "chatLockPinHash" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "chatLockEnabledAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "chatLockHideFolder" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ConversationMember" ADD COLUMN IF NOT EXISTS "lockedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "ConversationMember_userId_lockedAt_idx" ON "ConversationMember"("userId", "lockedAt");
