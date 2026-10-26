-- CreateEnum
CREATE TYPE "ScheduledCallStatus" AS ENUM ('UPCOMING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ScheduledCallInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- CreateTable
CREATE TABLE "ScheduledCall" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "media" "CallMedia" NOT NULL DEFAULT 'AUDIO',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "reminderMinutes" INTEGER NOT NULL DEFAULT 10,
    "organizerId" TEXT NOT NULL,
    "conversationId" TEXT,
    "status" "ScheduledCallStatus" NOT NULL DEFAULT 'UPCOMING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledCallParticipant" (
    "id" TEXT NOT NULL,
    "scheduledCallId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ScheduledCallInviteStatus" NOT NULL DEFAULT 'PENDING',
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledCallParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledCall_organizerId_startsAt_idx" ON "ScheduledCall"("organizerId", "startsAt");

-- CreateIndex
CREATE INDEX "ScheduledCall_status_startsAt_idx" ON "ScheduledCall"("status", "startsAt");

-- CreateIndex
CREATE INDEX "ScheduledCall_conversationId_idx" ON "ScheduledCall"("conversationId");

-- CreateIndex
CREATE INDEX "ScheduledCallParticipant_userId_idx" ON "ScheduledCallParticipant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledCallParticipant_scheduledCallId_userId_key" ON "ScheduledCallParticipant"("scheduledCallId", "userId");

-- AddForeignKey
ALTER TABLE "ScheduledCall" ADD CONSTRAINT "ScheduledCall_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledCall" ADD CONSTRAINT "ScheduledCall_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledCallParticipant" ADD CONSTRAINT "ScheduledCallParticipant_scheduledCallId_fkey" FOREIGN KEY ("scheduledCallId") REFERENCES "ScheduledCall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledCallParticipant" ADD CONSTRAINT "ScheduledCallParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
