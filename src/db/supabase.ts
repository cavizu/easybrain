import { createClient, SupabaseClient } from '@supabase/supabase-js';

export function getSupabaseClient(url?: string, key?: string): SupabaseClient {
  const supabaseUrl = url || process.env.SUPABASE_URL;
  const supabaseKey =
    key || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      'Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env, or set STORAGE_PROVIDER=local.'
    );
  }

  return createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
