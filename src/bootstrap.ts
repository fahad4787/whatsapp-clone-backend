import { hashPassword } from "./auth/crypto.js";
import { prisma } from "./db.js";

/** Ensures at least one admin exists (staging / first deploy). */
export async function ensureAdminSeed(): Promise<void> {
  const email = (process.env.ADMIN_SEED_EMAIL ?? "admin@aivora.dev").toLowerCase();
  const password = process.env.ADMIN_SEED_PASSWORD ?? "aivora-admin-change-me";
  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing) return;

  await prisma.adminUser.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      displayName: "Superadmin",
      role: "SUPER",
    },
  });
}
