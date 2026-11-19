import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../../plugins/auth.js";
import { packsToDto } from "../../stickersCatalog.js";

export async function adminStickerRoutes(app: FastifyInstance) {
  app.get("/api/admin/stickers", { preHandler: requireAdmin }, async () => {
    const packs = packsToDto();
    return {
      items: packs.map((p) => ({
        id: p.id,
        name: p.name,
        publisher: p.publisher,
        featured: p.featured,
        stickers: p.stickers.length,
        created: "seed",
      })),
      note: "Emoji packs are seeded in the app catalog (Wave 25). Upload packs are not enabled yet.",
    };
  });
}
