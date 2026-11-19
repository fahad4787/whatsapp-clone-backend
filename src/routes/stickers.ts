import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../plugins/auth.js";
import { isBlockedEitherWay } from "../blocks.js";
import { messageInclude, previewForRichType, toMessageDto } from "../messages.js";
import { realtimeHub } from "../realtime/hub.js";
import { findSticker, packsToDto } from "../stickersCatalog.js";

export async function stickerRoutes(app: FastifyInstance) {
  app.get("/api/stickers", { preHandler: requireUser }, async () => {
    return { items: packsToDto() };
  });

  app.post(
    "/api/conversations/:id/stickers",
    { preHandler: requireUser },
    async (req, reply) => {
      const userId = (req as typeof req & { userId: string }).userId;
      const { id } = req.params as { id: string };
      const parsed = z
        .object({
          sticker_id: z.string().min(1).max(64),
          client_id: z.string().max(80).optional().nullable(),
          reply_to: z
            .object({ id: z.string().min(1) })
            .optional()
            .nullable(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body" });
      }

      const found = findSticker(parsed.data.sticker_id);
      if (!found) return reply.code(404).send({ error: "sticker_not_found" });

      const member = await prisma.conversationMember.findUnique({
        where: { conversationId_userId: { conversationId: id, userId } },
      });
      if (!member) return reply.code(404).send({ error: "not_found" });

      const conv = await prisma.conversation.findUnique({
        where: { id },
        include: { members: { select: { userId: true, role: true } } },
      });
      if (!conv) return reply.code(404).send({ error: "not_found" });
      if (conv.type === "GROUP" && conv.onlyAdminsCanSend && member.role !== "ADMIN") {
        return reply.code(403).send({ error: "admins_only" });
      }
      if (conv.type === "DIRECT") {
        const peerId = conv.members.find((m) => m.userId !== userId)?.userId;
        if (peerId && (await isBlockedEitherWay(userId, peerId))) {
          return reply.code(403).send({ error: "blocked" });
        }
      }

      if (parsed.data.client_id) {
        const existing = await prisma.message.findUnique({
          where: {
            conversationId_clientId: {
              conversationId: id,
              clientId: parsed.data.client_id,
            },
          },
          include: messageInclude,
        });
        if (existing) return toMessageDto(existing, userId);
      }

      let replyToId: string | undefined;
      if (parsed.data.reply_to?.id) {
        const parent = await prisma.message.findFirst({
          where: { id: parsed.data.reply_to.id, conversationId: id },
        });
        if (!parent) return reply.code(400).send({ error: "invalid_reply_to" });
        replyToId = parent.id;
      }

      const payload = {
        sticker_id: found.sticker.id,
        emoji: found.sticker.emoji,
        label: found.sticker.label,
        pack_id: found.pack.id,
      };
      const text = previewForRichType("STICKER", payload);

      const created = await prisma.message.create({
        data: {
          conversationId: id,
          senderId: userId,
          type: "STICKER",
          text,
          payload,
          clientId: parsed.data.client_id ?? null,
          replyToId: replyToId ?? null,
        },
        include: messageInclude,
      });
      await prisma.conversation.update({
        where: { id },
        data: { updatedAt: new Date() },
      });

      const dto = toMessageDto(created, userId);
      realtimeHub.toRoom(id, { type: "message", data: dto });
      for (const peer of conv.members) {
        if (peer.userId !== userId) {
          realtimeHub.toUser(peer.userId, { type: "message", data: dto });
        }
      }
      return reply.code(201).send(dto);
    },
  );
}
