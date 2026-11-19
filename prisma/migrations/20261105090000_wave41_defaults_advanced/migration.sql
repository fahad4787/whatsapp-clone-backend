-- Wave 41 — default disappearing timer + advanced privacy
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "defaultDisappearingSeconds" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "protectIpInCalls" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "disableLinkPreviews" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "blockUnknownMessages" BOOLEAN NOT NULL DEFAULT false;
