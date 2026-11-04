-- Wave 22: two-step PIN + OTP purpose for change-number
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "twoStepPinHash" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "twoStepEnabledAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "twoStepEmail" TEXT;

ALTER TABLE "OtpChallenge" ADD COLUMN IF NOT EXISTS "purpose" TEXT NOT NULL DEFAULT 'login';
