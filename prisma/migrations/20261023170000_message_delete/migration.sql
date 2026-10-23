-- AlterTable
ALTER TABLE "Message" ADD COLUMN "deletedForEveryoneAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ConversationMember" ADD COLUMN "clearedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MessageHide" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageHide_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageHide_userId_idx" ON "MessageHide"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageHide_messageId_userId_key" ON "MessageHide"("messageId", "userId");

-- AddForeignKey
ALTER TABLE "MessageHide" ADD CONSTRAINT "MessageHide_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
