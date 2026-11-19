-- Wave 24: extended privacy + defaults
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "profilePhotoPrivacy" TEXT NOT NULL DEFAULT 'everyone';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "aboutPrivacy" TEXT NOT NULL DEFAULT 'everyone';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "groupsPrivacy" TEXT NOT NULL DEFAULT 'everyone';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "silenceUnknownCallers" BOOLEAN NOT NULL DEFAULT false;
