-- Wave 18: Status / Updates
ALTER TABLE "User" ADD COLUMN "statusPrivacy" TEXT NOT NULL DEFAULT 'contacts';
ALTER TABLE "User" ADD COLUMN "statusPrivacyIds" JSONB;

CREATE TABLE "Status" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'text',
    "text" TEXT,
    "background" TEXT,
    "attachment" JSONB,
    "audience" TEXT NOT NULL DEFAULT 'contacts',
    "audienceIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Status_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StatusView" (
    "id" TEXT NOT NULL,
    "statusId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reaction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusView_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Status_userId_createdAt_idx" ON "Status"("userId", "createdAt");
CREATE INDEX "Status_expiresAt_idx" ON "Status"("expiresAt");
CREATE UNIQUE INDEX "StatusView_statusId_userId_key" ON "StatusView"("statusId", "userId");
CREATE INDEX "StatusView_userId_idx" ON "StatusView"("userId");

ALTER TABLE "Status" ADD CONSTRAINT "Status_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StatusView" ADD CONSTRAINT "StatusView_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "Status"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StatusView" ADD CONSTRAINT "StatusView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
