import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Config (public Supabase URL + anon key) is fetched at runtime from the API,
// so the dashboard build needs no environment variables of its own.
let clientPromise: Promise<SupabaseClient> | null = null;

export function getSupabase(): Promise<SupabaseClient> {
  if (!clientPromise) {
    clientPromise = fetch('/api/survey/config')
      .then((r) => r.json())
      .then((cfg: { supabaseUrl: string; supabaseAnonKey: string }) =>
        createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        }),
      );
  }
  return clientPromise;
}
