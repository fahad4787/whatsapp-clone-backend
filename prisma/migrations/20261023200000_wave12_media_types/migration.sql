-- Wave 12: audio / file / video message types + link preview
ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'AUDIO';
ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'FILE';
ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'VIDEO';

ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "preview" JSONB;
