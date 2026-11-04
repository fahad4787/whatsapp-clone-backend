import { config } from "../config.js";

/** True when admin sms_enabled + Twilio env are ready to deliver. */
export function canSendSms(smsEnabled: boolean): boolean {
  if (!smsEnabled) return false;
  if (config.smsProvider !== "twilio") return false;
  return Boolean(
    config.twilioAccountSid && config.twilioAuthToken && config.twilioFromNumber,
  );
}

export async function sendOtpSms(phone: string, code: string): Promise<void> {
  if (config.smsProvider !== "twilio") {
    throw new Error("sms_provider_unavailable");
  }
  const sid = config.twilioAccountSid;
  const token = config.twilioAuthToken;
  const from = config.twilioFromNumber;
  const body = new URLSearchParams({
    To: phone,
    From: from,
    Body: `Your Aivora verification code is ${code}`,
  });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`twilio_failed:${res.status}:${text.slice(0, 200)}`);
  }
}
