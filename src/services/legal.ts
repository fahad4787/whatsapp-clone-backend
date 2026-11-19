import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { ensureAppConfigSeeded } from "./appConfig.js";

function asObject(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return {};
}

export const DEFAULT_LEGAL = {
  privacy_policy:
    "Privacy policy\n\nAivora collects account and usage data needed to provide messaging, calls, and related features. We do not sell your personal information. Contact support for data requests.",
  terms_of_service:
    "Terms of service\n\nBy using Aivora you agree to follow applicable laws and not abuse the service. We may suspend accounts that violate these terms. Features may change as the product evolves.",
} as const;

export type LegalDocs = {
  privacy_policy: string;
  terms_of_service: string;
};

export async function getLegalDocs(): Promise<LegalDocs> {
  await ensureAppConfigSeeded();
  const row = await prisma.appConfig.findUnique({ where: { id: "default" } });
  const o = asObject(row?.data);
  return {
    privacy_policy:
      typeof o.privacy_policy === "string" && o.privacy_policy.trim()
        ? o.privacy_policy
        : DEFAULT_LEGAL.privacy_policy,
    terms_of_service:
      typeof o.terms_of_service === "string" && o.terms_of_service.trim()
        ? o.terms_of_service
        : DEFAULT_LEGAL.terms_of_service,
  };
}

export async function setLegalDocs(docs: LegalDocs): Promise<LegalDocs> {
  await ensureAppConfigSeeded();
  const row = await prisma.appConfig.findUnique({ where: { id: "default" } });
  const data = {
    ...asObject(row?.data),
    privacy_policy: docs.privacy_policy,
    terms_of_service: docs.terms_of_service,
  };
  await prisma.appConfig.update({
    where: { id: "default" },
    data: { data: data as Prisma.InputJsonValue },
  });
  return docs;
}
