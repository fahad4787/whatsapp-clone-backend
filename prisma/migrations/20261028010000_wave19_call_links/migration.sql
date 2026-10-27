-- Wave 19: shareable call links
CREATE TABLE "CallLink" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "media" "CallMedia" NOT NULL DEFAULT 'AUDIO',
    "title" TEXT,
    "creatorId" TEXT NOT NULL,
    "activeCallId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CallLink_code_key" ON "CallLink"("code");
CREATE INDEX "CallLink_creatorId_idx" ON "CallLink"("creatorId");
CREATE INDEX "CallLink_expiresAt_idx" ON "CallLink"("expiresAt");

ALTER TABLE "CallLink" ADD CONSTRAINT "CallLink_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallLink" ADD CONSTRAINT "CallLink_activeCallId_fkey" FOREIGN KEY ("activeCallId") REFERENCES "Call"("id") ON DELETE SET NULL ON UPDATE CASCADE;
