-- Wave 21: channels + communities
CREATE TABLE IF NOT EXISTS "Channel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "avatarUrl" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "listed" BOOLEAN NOT NULL DEFAULT true,
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Channel_slug_key" ON "Channel"("slug");
CREATE INDEX IF NOT EXISTS "Channel_listed_updatedAt_idx" ON "Channel"("listed", "updatedAt");

CREATE TABLE IF NOT EXISTS "ChannelFollow" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChannelFollow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChannelFollow_channelId_userId_key" ON "ChannelFollow"("channelId", "userId");
CREATE INDEX IF NOT EXISTS "ChannelFollow_userId_idx" ON "ChannelFollow"("userId");

CREATE TABLE IF NOT EXISTS "ChannelPost" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "authorId" TEXT,
    "text" TEXT NOT NULL,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChannelPost_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ChannelPost_channelId_createdAt_idx" ON "ChannelPost"("channelId", "createdAt");

CREATE TABLE IF NOT EXISTS "ChannelPostReaction" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChannelPostReaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChannelPostReaction_postId_userId_key" ON "ChannelPostReaction"("postId", "userId");
CREATE INDEX IF NOT EXISTS "ChannelPostReaction_postId_idx" ON "ChannelPostReaction"("postId");

CREATE TABLE IF NOT EXISTS "Community" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "avatarUrl" TEXT,
    "announcementConversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Community_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CommunityMember" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommunityMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CommunityMember_communityId_userId_key" ON "CommunityMember"("communityId", "userId");
CREATE INDEX IF NOT EXISTS "CommunityMember_userId_idx" ON "CommunityMember"("userId");

CREATE TABLE IF NOT EXISTS "CommunityGroupLink" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommunityGroupLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CommunityGroupLink_communityId_conversationId_key" ON "CommunityGroupLink"("communityId", "conversationId");
CREATE INDEX IF NOT EXISTS "CommunityGroupLink_conversationId_idx" ON "CommunityGroupLink"("conversationId");

ALTER TABLE "ChannelFollow" DROP CONSTRAINT IF EXISTS "ChannelFollow_channelId_fkey";
ALTER TABLE "ChannelFollow" ADD CONSTRAINT "ChannelFollow_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChannelPost" DROP CONSTRAINT IF EXISTS "ChannelPost_channelId_fkey";
ALTER TABLE "ChannelPost" ADD CONSTRAINT "ChannelPost_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChannelPostReaction" DROP CONSTRAINT IF EXISTS "ChannelPostReaction_postId_fkey";
ALTER TABLE "ChannelPostReaction" ADD CONSTRAINT "ChannelPostReaction_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ChannelPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommunityMember" DROP CONSTRAINT IF EXISTS "CommunityMember_communityId_fkey";
ALTER TABLE "CommunityMember" ADD CONSTRAINT "CommunityMember_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommunityGroupLink" DROP CONSTRAINT IF EXISTS "CommunityGroupLink_communityId_fkey";
ALTER TABLE "CommunityGroupLink" ADD CONSTRAINT "CommunityGroupLink_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;
