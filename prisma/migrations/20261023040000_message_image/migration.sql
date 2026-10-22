-- AlterEnum
ALTER TYPE "MessageType" ADD VALUE 'IMAGE';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "attachment" JSONB;
