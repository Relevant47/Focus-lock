// Outbound email via Resend. Fails open: when RESEND_API_KEY is unset (dev,
// self-host without email yet), falls back to the console.log behaviour the
// resetRequest handler had before — so the dev workflow keeps working.
//
// We don't surface delivery failures to the caller. /auth/reset-request
// already returns the same response whether the email exists or not (to
// prevent account enumeration), and surfacing email send errors would leak
// "this email is registered" anyway. Operators see failures in worker logs.

import type { Env } from './types';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'FocusLock <onboarding@resend.dev>';
const DEFAULT_RESET_URL_BASE = 'https://tryfocuslock.com/reset';

export async function sendResetEmail(
  env: Env,
  toEmail: string,
  resetToken: string,
): Promise<void> {
  const base = env.RESET_URL_BASE || DEFAULT_RESET_URL_BASE;
  const url = `${base}?token=${encodeURIComponent(resetToken)}`;

  // Fallback: log only when no API key is configured. Keeps dev/self-host
  // running without forcing a Resend account.
  if (!env.RESEND_API_KEY) {
    console.log(`[reset-email] (no RESEND_API_KEY set) to=${toEmail} url=${url}`);
    return;
  }

  const from = env.EMAIL_FROM || DEFAULT_FROM;
  const subject = 'Reset your FocusLock password';
  const text = [
    'Someone — probably you — asked to reset your FocusLock password.',
    '',
    `Click here to choose a new one: ${url}`,
    '',
    'This link expires in 1 hour. If you didn\'t request a reset, ignore this email — your password is unchanged.',
    '',
    '— FocusLock',
  ].join('\n');
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;line-height:1.55">
      <p style="font-size:15px">Someone &mdash; probably you &mdash; asked to reset your FocusLock password.</p>
      <p style="margin:28px 0">
        <a href="${url}" style="display:inline-block;background:#6366f1;color:white;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:14px">
          Choose a new password
        </a>
      </p>
      <p style="font-size:13px;color:#666">Or paste this link into your browser:<br><span style="word-break:break-all">${url}</span></p>
      <p style="font-size:13px;color:#666;margin-top:32px;padding-top:16px;border-top:1px solid #eee">
        This link expires in 1 hour. If you didn't request a reset, ignore this email &mdash; your password is unchanged.
      </p>
      <p style="font-size:12px;color:#999">&mdash; FocusLock</p>
    </div>
  `.trim();

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from, to: toEmail, subject, text, html }),
    });
    if (!res.ok) {
      const body = await res.text();
      // Log but don't throw — we don't want one Resend hiccup to surface
      // "user does/doesn't exist" via a different response.
      console.error(`[reset-email] resend status=${res.status} body=${body}`);
    }
  } catch (err) {
    console.error('[reset-email] resend threw', err);
  }
}
