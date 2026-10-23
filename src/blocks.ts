import { prisma } from "./db.js";

/** True if either user has blocked the other. */
export async function isBlockedEitherWay(userA: string, userB: string): Promise<boolean> {
  const row = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: userA, blockedId: userB },
        { blockerId: userB, blockedId: userA },
      ],
    },
    select: { id: true },
  });
  return Boolean(row);
}
