-- Wave 42 — custom chat lists
CREATE TABLE IF NOT EXISTS "ChatList" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChatList_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ChatListMember" (
    "listId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    CONSTRAINT "ChatListMember_pkey" PRIMARY KEY ("listId","conversationId")
);

CREATE INDEX IF NOT EXISTS "ChatList_userId_sortOrder_idx" ON "ChatList"("userId", "sortOrder");
CREATE INDEX IF NOT EXISTS "ChatListMember_conversationId_idx" ON "ChatListMember"("conversationId");

DO $$ BEGIN
  ALTER TABLE "ChatList" ADD CONSTRAINT "ChatList_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ChatListMember" ADD CONSTRAINT "ChatListMember_listId_fkey"
    FOREIGN KEY ("listId") REFERENCES "ChatList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ChatListMember" ADD CONSTRAINT "ChatListMember_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
