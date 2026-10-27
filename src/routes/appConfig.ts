import type { FastifyInstance } from "fastify";
import {
  getAppSettings,
  listCountries,
  toPublicConfig,
} from "../services/appConfig.js";

/** Public config for Android / clients (Wave 20). */
export async function appConfigRoutes(app: FastifyInstance) {
  app.get("/api/app/config", async () => {
    const [settings, countries] = await Promise.all([
      getAppSettings(),
      listCountries({ enabledOnly: true }),
    ]);
    return toPublicConfig(settings, countries);
  });
}
