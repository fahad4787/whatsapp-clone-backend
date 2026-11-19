import type { FastifyInstance } from "fastify";
import { getLegalDocs } from "../services/legal.js";

/** Public legal docs for Android Help screens. */
export async function legalRoutes(app: FastifyInstance) {
  app.get("/api/legal", async () => getLegalDocs());
}
