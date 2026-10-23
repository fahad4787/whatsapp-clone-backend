import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/auth/crypto.js";

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.ADMIN_SEED_EMAIL ?? "admin@aivora.dev").toLowerCase();
  const password = process.env.ADMIN_SEED_PASSWORD ?? "aivora-admin-change-me";
  const passwordHash = await hashPassword(password);

  const admin = await prisma.adminUser.upsert({
    where: { email },
    create: {
      email,
      passwordHash,
      displayName: "Superadmin",
      role: "SUPER",
    },
    update: {
      passwordHash,
      role: "SUPER",
    },
  });

  console.log(`Seeded admin ${admin.email} (password from ADMIN_SEED_PASSWORD / default)`);

  // Demo contacts so New chat / New group always have someone to pick (dev).
  const demos = [
    { phone: "+920000000001", displayName: "Demo Friend" },
    { phone: "+920000000002", displayName: "Demo Buddy" },
  ];
  for (const d of demos) {
    const u = await prisma.user.upsert({
      where: { phone: d.phone },
      create: { phone: d.phone, displayName: d.displayName, about: "Demo account" },
      update: { displayName: d.displayName, about: "Demo account", bannedAt: null },
    });
    console.log(`Seeded demo user ${u.displayName} (${u.phone})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
