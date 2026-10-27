-- Wave 20: app config singleton + countries allowlist
CREATE TABLE "AppConfig" (
    "id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Country" (
    "iso" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dial" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Country_pkey" PRIMARY KEY ("iso")
);

CREATE INDEX "Country_enabled_sortOrder_idx" ON "Country"("enabled", "sortOrder");
