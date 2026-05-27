// Thin fetch wrapper around the Vercel survey API (api/survey/*).
// Mirrors lib/familyApi.ts conventions: status 0 means "offline / network error"
// so callers can queue and retry. Base URL is the production site by default;
// override with VITE_SURVEY_API_URL at build time (e.g. a preview deployment).

const ENV_URL: string | undefined = (import.meta as any).env?.VITE_SURVEY_API_URL;
export const surveyApiUrl: string = ENV_URL ?? 'https://focuslock.app';

/** Hosted page that renders the Beehiiv inline subscribe form; iframed by the
 *  survey's newsletter step so the signup happens in-app with no API key. The UTM
 *  params are read by Beehiiv's attribution.js on that page, tagging each signup
 *  with source=in-app-survey for segmentation. */
export const newsletterEmbedUrl = `${surveyApiUrl}/newsletter-embed.html?utm_source=in-app-survey&utm_medium=app&utm_campaign=in-app-survey`;

export class SurveyApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'SurveyApiError';
  }
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${surveyApiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SurveyApiError(0, 'offline'); // network failure — caller may queue
  }
  const text = await res.text();
  const data = text ? safeParse(text) : null;
  if (!res.ok) {
    const msg = data && typeof data === 'object' && 'error' in data ? String(data.error) : `request failed (${res.status})`;
    throw new SurveyApiError(res.status, msg);
  }
  return data as T;
}

export interface SubmitResult { success: boolean; id: string | null }
export interface NewsletterResult { success: boolean; subscribed: boolean; message: string }
export type PromptEvent = 'shown' | 'dismissed' | 'snoozed' | 'started' | 'abandoned' | 'completed';

export function submitSurvey(payload: Record<string, unknown>): Promise<SubmitResult> {
  return post<SubmitResult>('/api/survey/submit', payload);
}

export function subscribeNewsletter(email: string, consent: boolean, installId: string): Promise<NewsletterResult> {
  return post<NewsletterResult>('/api/survey/newsletter', { email, consent, install_id: installId });
}

export function deleteResponse(id: string): Promise<{ success: boolean }> {
  return post<{ success: boolean }>('/api/survey/delete', { id });
}

/** Fire-and-forget funnel event — a dropped analytics ping must never surface to the user. */
export function sendPromptEvent(event: PromptEvent, installId: string, appVersion: string | null, step?: number): void {
  post('/api/survey/prompt-event', { event, install_id: installId, app_version: appVersion, step }).catch(() => {});
}
