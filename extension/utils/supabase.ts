// ============================================================
// Supabase Client — Singleton
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { clearProfileCache } from './profileCache';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string) || 'https://placeholder.supabase.co';
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || 'placeholder-anon-key';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // Store session in chrome.storage.local for persistence across popup open/close
    storage: {
      getItem: async (key: string) => {
        return new Promise((resolve) => {
          chrome.storage.local.get([key], (result) => {
            resolve(result[key] ?? null);
          });
        });
      },
      setItem: async (key: string, value: string) => {
        return new Promise((resolve) => {
          chrome.storage.local.set({ [key]: value }, () => resolve());
        });
      },
      removeItem: async (key: string) => {
        return new Promise((resolve) => {
          chrome.storage.local.remove([key], () => resolve());
        });
      },
    },
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

const GUEST_USER = {
  id: 'local-guest-user',
  email: 'guest@memorafill.local',
  user_metadata: { full_name: 'Guest User' },
  app_metadata: {},
  aud: 'authenticated',
  created_at: new Date().toISOString(),
};

export async function isGuestMode(): Promise<boolean> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const res = await chrome.storage.local.get('jobfill_guest_mode');
    return Boolean(res.jobfill_guest_mode);
  }
  return localStorage.getItem('jobfill_guest_mode') === 'true';
}

export async function setGuestMode(enabled: boolean): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    if (enabled) {
      await chrome.storage.local.set({ jobfill_guest_mode: true });
    } else {
      await chrome.storage.local.remove('jobfill_guest_mode');
    }
    return;
  }
  if (enabled) localStorage.setItem('jobfill_guest_mode', 'true');
  else localStorage.removeItem('jobfill_guest_mode');
}

/** Get the current logged-in user, or null if not logged in */
export async function getCurrentUser() {
  if (await isGuestMode()) {
    return GUEST_USER as any;
  }
  try {
    const { data: { user } } = await supabase.auth.getUser();
    return user;
  } catch {
    return null;
  }
}

/** Get current session */
export async function getSession() {
  if (await isGuestMode()) {
    return {
      access_token: 'local-guest-token',
      refresh_token: 'local-guest-refresh-token',
      user: GUEST_USER,
      token_type: 'bearer',
      expires_in: 3600,
    } as any;
  }
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session;
  } catch {
    return null;
  }
}

/** Sign out and clear all local guest/cached session data so the next user starts fresh */
export async function signOut() {
  await clearProfileCache();
  await setGuestMode(false);
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.remove([
      'jobfill_guest_mode',
      'personal_copilot_profile',
      'local_guest_documents',
      'jf_document_registry',
      'jobfill_onboarding_done_local-guest-user',
    ]);
  }
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.clear();
  }
  try {
    await supabase.auth.signOut();
  } catch {}
}
