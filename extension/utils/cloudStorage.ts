// ============================================================
// Cloud Storage — Supabase
// ============================================================
// Replaces local IndexedDB storage with Supabase cloud storage.
// Profile data → Supabase `profiles` table
// Document metadata → Supabase `documents` table
// Document files → Supabase Storage `user-documents` bucket
// ============================================================

import type { UserProfile } from '../types/profile';
import type { StoredDocument } from '../types/document';
import { createEmptyProfile } from '../types/profile';
import { supabase, getCurrentUser, getSession } from './supabase';
import { readProfileCache, writeProfileCache } from './profileCache';
import { deleteDocumentRegistryMetadata, mergeDocumentRegistryMetadata } from './documentRegistry';

// ---- Profile Operations ----

export interface CloudProfileResult {
  profile: UserProfile;
  hasSavedProfile: boolean;
}

// Concurrent callers (the autofill pipelines run in parallel) share one request.
let inFlightProfileLoad: { userId: string; promise: Promise<CloudProfileResult> } | null = null;

/**
 * Load user profile with status indicating whether a full profile was saved.
 * The user id comes from the locally stored session (no auth-server round trip; Supabase
 * row-level security still enforces access on the profiles query). Results are served from a
 * short-lived memory cache, and concurrent callers share one in-flight request.
 */
export async function cloudGetProfileWithStatus(): Promise<CloudProfileResult> {
  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) throw new Error('Not authenticated');

  const cached = await readProfileCache(userId);
  if (cached) return { profile: cached.profile, hasSavedProfile: cached.hasSavedProfile };

  if (inFlightProfileLoad?.userId === userId) return inFlightProfileLoad.promise;

  const promise = fetchProfileFromSupabase(userId)
    .then(async (result) => {
      await writeProfileCache(userId, result.profile, result.hasSavedProfile);
      return result;
    })
    .finally(() => {
      if (inFlightProfileLoad?.promise === promise) inFlightProfileLoad = null;
    });
  inFlightProfileLoad = { userId, promise };
  return promise;
}

async function fetchProfileFromSupabase(userId: string): Promise<CloudProfileResult> {
  const user = { id: userId };

  if (user.id === 'local-guest-user') {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get('personal_copilot_profile');
      if (res.personal_copilot_profile) {
        return { profile: res.personal_copilot_profile as UserProfile, hasSavedProfile: true };
      }
    }
    return { profile: createEmptyProfile(), hasSavedProfile: false };
  }

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (error || !data) {
      // Return empty profile if not found yet
      return { profile: createEmptyProfile(), hasSavedProfile: false };
    }

    // Parse the JSON profile data stored in the `summary` column
    // We store the full UserProfile as JSON in the summary field
    if (data.summary && data.summary.startsWith('{')) {
      return {
        profile: JSON.parse(data.summary) as UserProfile,
        hasSavedProfile: true,
      };
    }

    // Fallback: construct profile from individual columns
    const profile = createEmptyProfile();
    const nameParts = (data.full_name || '').split(' ');
    profile.personal.firstName = nameParts[0] || '';
    profile.personal.lastName = nameParts.slice(1).join(' ') || '';
    if (data.email) {
      profile.emails = [{ id: crypto.randomUUID(), value: data.email, label: 'Personal', primary: true }];
    }
    if (data.phone) {
      profile.phones = [{ id: crypto.randomUUID(), value: data.phone, label: 'Personal', primary: true }];
    }
    if (data.address) {
      profile.addresses = [{ id: crypto.randomUUID(), label: 'Current', primary: true, line1: data.address, city: '', state: '', postalCode: '', country: '' }];
    }
    if (data.linkedin_url) {
      profile.professional.linkedin = data.linkedin_url;
    }
    return { profile, hasSavedProfile: false };
  } catch (err) {
    console.warn('[cloudStorage] Supabase fetch failed, falling back to local storage:', err);
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get('personal_copilot_profile');
      if (res.personal_copilot_profile) {
        return { profile: res.personal_copilot_profile as UserProfile, hasSavedProfile: true };
      }
    }
    return { profile: createEmptyProfile(), hasSavedProfile: false };
  }
}

/** Load user profile from Supabase */
export async function cloudGetProfile(): Promise<UserProfile> {
  const { profile } = await cloudGetProfileWithStatus();
  return profile;
}

/** Save user profile to Supabase */
export async function cloudSaveProfile(profile: UserProfile): Promise<void> {
  const user = await getCurrentUser();
  if (!user) throw new Error('Not authenticated');

  // Always store locally as reliable cache/fallback
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ personal_copilot_profile: profile });
  }

  if (user.id === 'local-guest-user') {
    return;
  }

  const primaryEmail = profile.emails.find(e => e.primary)?.value || profile.emails[0]?.value || '';
  const primaryPhone = profile.phones.find(p => p.primary)?.value || profile.phones[0]?.value || '';
  const primaryAddress = profile.addresses.find(a => a.primary)?.line1 || profile.addresses[0]?.line1 || '';

  try {
    const { error } = await supabase
      .from('profiles')
      .upsert({
        id: user.id,
        full_name: `${profile.personal.firstName} ${profile.personal.lastName}`.trim(),
        email: primaryEmail,
        phone: primaryPhone,
        address: primaryAddress,
        linkedin_url: profile.professional?.linkedin || '',
        summary: JSON.stringify(profile), // Store full profile as JSON
        updated_at: new Date().toISOString(),
      });

    if (error) console.warn(`Supabase save profile warning: ${error.message}`);
  } catch (err) {
    console.warn('[cloudStorage] Supabase save failed (local backup succeeded):', err);
  }

  // Write through so the background pipelines never autofill from a pre-save profile.
  await writeProfileCache(user.id, profile, true);
}

// ---- Document Operations ----

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, data] = dataUrl.split(',');
  const mimeMatch = header.match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/** Save a document (metadata + file) to Supabase */
export async function cloudSaveDocument(
  meta: StoredDocument,
  blob: Blob,
): Promise<void> {
  const user = await getCurrentUser();
  if (!user) throw new Error('Not authenticated');

  // Always cache the binary file blob locally so autofill and uploads work instantly without network dependency
  try {
    const dataUrl = await blobToDataUrl(blob);
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [`doc_blob_${meta.id}`]: dataUrl });
    }
  } catch (err) {
    console.warn('[JobFill] Failed to store document blob locally:', err);
  }

  if (user.id === 'local-guest-user') {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get('local_guest_documents');
      const docs = (res.local_guest_documents || []) as StoredDocument[];
      await chrome.storage.local.set({
        local_guest_documents: [...docs.filter(d => d.id !== meta.id), meta],
      });
    }
    return;
  }

  const storagePath = `${user.id}/${meta.id}`;

  // Upload file to Supabase Storage
  try {
    const { error: uploadError } = await supabase.storage
      .from('user-documents')
      .upload(storagePath, blob, {
        contentType: meta.mimeType,
        upsert: true,
      });

    if (uploadError) console.warn(`Supabase storage upload failed: ${uploadError.message}`);
  } catch (err) {
    console.warn('Supabase storage upload exception:', err);
  }

  // Save metadata to documents table
  try {
    const { error: metaError } = await supabase
      .from('documents')
      .upsert({
        id: meta.id,
        user_id: user.id,
        original_name: meta.originalName,
        mime_type: meta.mimeType,
        size: meta.sizeBytes,
        category: meta.category,
        storage_path: storagePath,
        created_at: meta.createdAt,
      });

    if (metaError) console.warn(`Metadata save failed: ${metaError.message}`);
  } catch (err) {
    console.warn('Metadata save exception:', err);
  }
}

/** Load all document metadata from Supabase */
export async function cloudLoadAllDocumentMetadata(): Promise<StoredDocument[]> {
  const user = await getCurrentUser();
  if (!user) return [];

  if (user.id === 'local-guest-user') {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get('local_guest_documents');
      return (res.local_guest_documents || []) as StoredDocument[];
    }
    return [];
  }

  try {
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error || !data) return [];

    const documents = data.map((doc) => ({
      id: doc.id,
      name: doc.original_name,
      originalName: doc.original_name,
      mimeType: doc.mime_type,
      category: doc.category as StoredDocument['category'],
      sizeBytes: doc.size,
      createdAt: doc.created_at,
      updatedAt: doc.created_at,
    }));
    return mergeDocumentRegistryMetadata(documents);
  } catch {
    return [];
  }
}

/** Load a document's file blob from Supabase Storage */
export async function cloudLoadDocumentBlob(docId: string): Promise<Blob> {
  // 1. Check local storage cache first (fast, works offline, works in guest mode)
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const key = `doc_blob_${docId}`;
      const res = await chrome.storage.local.get(key);
      if (res[key] && typeof res[key] === 'string') {
        return dataUrlToBlob(res[key]);
      }
    } catch (err) {
      console.warn('[JobFill] Failed to read cached blob:', err);
    }
  }

  const user = await getCurrentUser();
  if (!user) throw new Error('Not authenticated');

  if (user.id === 'local-guest-user') {
    throw new Error('Document file data was not found locally. Please re-upload your resume in the Docs tab.');
  }

  const storagePath = `${user.id}/${docId}`;

  const { data, error } = await supabase.storage
    .from('user-documents')
    .download(storagePath);

  if (error || !data) throw new Error(`Download failed: ${error?.message || 'No data'}`);

  // Cache locally for subsequent offline/instant uploads
  try {
    const dataUrl = await blobToDataUrl(data);
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [`doc_blob_${docId}`]: dataUrl });
    }
  } catch {}

  return data;
}

/** Delete a document (metadata + file) from Supabase */
export async function cloudDeleteDocument(docId: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user) throw new Error('Not authenticated');

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.remove(`doc_blob_${docId}`).catch(() => undefined);
  }

  if (user.id === 'local-guest-user') {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get('local_guest_documents');
      const docs = (res.local_guest_documents || []) as StoredDocument[];
      await chrome.storage.local.set({
        local_guest_documents: docs.filter(d => d.id !== docId),
      });
    }
    await deleteDocumentRegistryMetadata(docId);
    return;
  }

  const storagePath = `${user.id}/${docId}`;

  // Delete file from storage
  await supabase.storage
    .from('user-documents')
    .remove([storagePath]);

  // Delete metadata from table
  await supabase
    .from('documents')
    .delete()
    .eq('id', docId)
    .eq('user_id', user.id);

  await deleteDocumentRegistryMetadata(docId);
}

/** Get document count for the current user */
export async function cloudGetDocumentCount(): Promise<number> {
  const user = await getCurrentUser();
  if (!user) return 0;

  if (user.id === 'local-guest-user') {
    const docs = await cloudLoadAllDocumentMetadata();
    return docs.length;
  }

  try {
    const { count, error } = await supabase
      .from('documents')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id);

    if (error) return 0;
    return count || 0;
  } catch {
    return 0;
  }
}
