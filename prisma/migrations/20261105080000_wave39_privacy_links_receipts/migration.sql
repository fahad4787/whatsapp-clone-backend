-- Wave 39 — Links privacy + read receipts
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "linksPrivacy" TEXT NOT NULL DEFAULT 'contacts';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "readReceipts" BOOLEAN NOT NULL DEFAULT true;
