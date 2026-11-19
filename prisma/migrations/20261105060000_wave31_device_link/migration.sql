-- Wave 31: companion device pairing sessions
CREATE TABLE IF NOT EXISTS "DeviceLinkSession" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "deviceName" TEXT,
    "platform" TEXT,
    "userId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceLinkSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DeviceLinkSession_code_key" ON "DeviceLinkSession"("code");
CREATE INDEX IF NOT EXISTS "DeviceLinkSession_status_expiresAt_idx" ON "DeviceLinkSession"("status", "expiresAt");

ALTER TABLE "DeviceLinkSession"
  ADD CONSTRAINT "DeviceLinkSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
