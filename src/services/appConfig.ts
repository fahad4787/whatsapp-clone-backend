import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

/** Defaults aligned with aivora-admin SettingsMap / seed. */
export const DEFAULT_APP_SETTINGS = {
  otp_length: 6,
  otp_expiry: 300,
  otp_attempts: 5,
  otp_gap: 60,
  otp_per_phone_hourly: 5,
  otp_per_ip_hourly: 300,
  ring_timeout: 60,
  max_group_call_participants: 32,
  max_group_size: 256,
  upload_limit_mb: 100,
  edit_window_minutes: 15,
  maintenance_mode: false,
  latest_android_version: "1.0.0",
  latest_android_version_code: 1,
  min_android_version_code: 1,
  download_url: "https://whatsapp-clone-backend-hep1.onrender.com/",
  allow_people_search: true,
  min_search_chars: 3,
  sms_enabled: false,
} as const;

export type AppSettings = { [K in keyof typeof DEFAULT_APP_SETTINGS]: number | boolean | string };

const DEFAULT_COUNTRIES: { iso: string; name: string; dial: string; enabled: boolean; sortOrder: number }[] =
  [
    { iso: "PK", name: "Pakistan", dial: "+92", enabled: true, sortOrder: 1 },
    { iso: "AE", name: "United Arab Emirates", dial: "+971", enabled: true, sortOrder: 2 },
    { iso: "OM", name: "Oman", dial: "+968", enabled: true, sortOrder: 3 },
    { iso: "AU", name: "Australia", dial: "+61", enabled: true, sortOrder: 4 },
    { iso: "US", name: "United States", dial: "+1", enabled: true, sortOrder: 5 },
    { iso: "GB", name: "United Kingdom", dial: "+44", enabled: false, sortOrder: 6 },
  ];

function asObject(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return {};
}

export function mergeSettings(raw: unknown): AppSettings {
  const o = asObject(raw);
  const out: Record<string, number | boolean | string> = { ...DEFAULT_APP_SETTINGS };
  for (const key of Object.keys(DEFAULT_APP_SETTINGS) as (keyof typeof DEFAULT_APP_SETTINGS)[]) {
    if (o[key] !== undefined && o[key] !== null) {
      out[key] = o[key] as number | boolean | string;
    }
  }
  return out as AppSettings;
}

export async function ensureAppConfigSeeded(): Promise<AppSettings> {
  const existing = await prisma.appConfig.findUnique({ where: { id: "default" } });
  if (!existing) {
    const created = await prisma.appConfig.create({
      data: {
        id: "default",
        data: DEFAULT_APP_SETTINGS as unknown as Prisma.InputJsonValue,
      },
    });
    return mergeSettings(created.data);
  }
  return mergeSettings(existing.data);
}

export async function getAppSettings(): Promise<AppSettings> {
  return ensureAppConfigSeeded();
}

export async function updateAppSettings(
  patch: Record<string, unknown>,
): Promise<AppSettings> {
  const current = await getAppSettings();
  const next = mergeSettings({ ...current, ...patch });
  await prisma.appConfig.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      data: next as unknown as Prisma.InputJsonValue,
    },
    update: {
      data: next as unknown as Prisma.InputJsonValue,
    },
  });
  return next;
}

export async function ensureCountriesSeeded(): Promise<void> {
  const count = await prisma.country.count();
  if (count > 0) return;
  await prisma.country.createMany({
    data: DEFAULT_COUNTRIES,
    skipDuplicates: true,
  });
}

export async function listCountries(opts?: { enabledOnly?: boolean }) {
  await ensureCountriesSeeded();
  return prisma.country.findMany({
    where: opts?.enabledOnly ? { enabled: true } : undefined,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

/** Accepts "92", "+92", or "PK". */
export async function isCountryAllowed(countryInput: string): Promise<boolean> {
  await ensureCountriesSeeded();
  const raw = countryInput.trim();
  if (!raw) return false;
  const digits = raw.replace(/\D/g, "");
  const iso = raw.length === 2 ? raw.toUpperCase() : null;
  const rows = await prisma.country.findMany({ where: { enabled: true } });
  return rows.some((c) => {
    if (iso && c.iso === iso) return true;
    const dialDigits = c.dial.replace(/\D/g, "");
    return dialDigits === digits || c.dial === raw || c.dial === `+${digits}`;
  });
}

export function toPublicConfig(settings: AppSettings, countries: Awaited<ReturnType<typeof listCountries>>) {
  return {
    maintenance_mode: Boolean(settings.maintenance_mode),
    latest_android_version: String(settings.latest_android_version),
    latest_android_version_code: Number(settings.latest_android_version_code),
    min_android_version_code: Number(settings.min_android_version_code),
    download_url: String(settings.download_url),
    allow_people_search: Boolean(settings.allow_people_search),
    min_search_chars: Number(settings.min_search_chars),
    ring_timeout: Number(settings.ring_timeout),
    max_group_size: Number(settings.max_group_size),
    max_group_call_participants: Number(settings.max_group_call_participants),
    upload_limit_mb: Number(settings.upload_limit_mb),
    countries: countries.map((c) => ({
      iso: c.iso,
      name: c.name,
      dial: c.dial,
      enabled: c.enabled,
    })),
  };
}
