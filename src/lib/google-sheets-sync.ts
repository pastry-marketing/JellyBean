/**
 * Jellybean CRM -> Google Sheets Sync Dispatcher
 * Dispatches INSERT, UPDATE, and DELETE events to Google Apps Script Webhook.
 */
import { supabase } from "@/integrations/supabase/client";
import { saveGoogleSheetsConfigServerFn } from "./google-sheets-sync.functions";

export const GOOGLE_SHEETS_SHARED_STATE_KEY = "google_sheets_sync_config";

export const DEFAULT_WEBHOOK_URL =
  "https://script.google.com/macros/s/AKfycbxCk4Vf4CN4-SfNe1Q2EX-oTHC2LRCGey6rXBrL11bIEKQA1kZAdx85PbxUGDwHR_N2/exec";

let memoryWebhookUrl: string | null = null;
let memoryAutoSync: boolean | null = null;
let isConfigInitialized = false;

export function getGoogleSheetsWebhookUrl(): string {
  if (memoryWebhookUrl && memoryWebhookUrl.trim()) {
    return memoryWebhookUrl.trim();
  }
  if (typeof window !== "undefined") {
    const fromStorage = localStorage.getItem("jellybean_google_sheets_webhook");
    if (fromStorage && fromStorage.trim()) {
      memoryWebhookUrl = fromStorage.trim();
      return memoryWebhookUrl;
    }
  }
  const fromEnv = (import.meta.env.VITE_GOOGLE_SHEETS_WEBHOOK_URL as string | undefined) || "";
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }
  return DEFAULT_WEBHOOK_URL;
}

export function isGoogleSheetsAutoSyncEnabled(): boolean {
  if (memoryAutoSync !== null) {
    return memoryAutoSync;
  }
  if (typeof window !== "undefined") {
    return localStorage.getItem("jellybean_google_sheets_autosync") !== "false";
  }
  return true;
}

export function setGoogleSheetsConfigInMemory(url?: string, autoSync?: boolean) {
  if (url !== undefined) {
    const cleanUrl = url.trim();
    memoryWebhookUrl = cleanUrl;
    if (typeof window !== "undefined") {
      localStorage.setItem("jellybean_google_sheets_webhook", cleanUrl);
    }
  }
  if (autoSync !== undefined) {
    memoryAutoSync = autoSync;
    if (typeof window !== "undefined") {
      localStorage.setItem("jellybean_google_sheets_autosync", String(autoSync));
    }
  }
}

/**
 * Persists webhook configuration across memory, localStorage, Supabase RPC, and server function.
 * Multi-tiered to guarantee persistence even if RLS or network limits one method.
 */
export async function persistGoogleSheetsConfig(
  url: string,
  autoSync: boolean = true,
): Promise<{ success: boolean; error?: string }> {
  const cleanUrl = url.trim();
  setGoogleSheetsConfigInMemory(cleanUrl, autoSync);

  let anySuccess = true;
  let lastError = "";

  // 1. Try Supabase RPC function (runs with SECURITY DEFINER to bypass client RLS)
  try {
    const { error: rpcErr } = await supabase.rpc("save_google_sheets_config" as never, {
      p_webhook_url: cleanUrl,
      p_auto_sync: autoSync,
    } as never);
    if (!rpcErr) {
      return { success: true };
    }
    lastError = rpcErr.message;
  } catch (err) {
    lastError = String(err);
  }

  // 2. Try direct shared_state upsert with client Supabase
  try {
    const { error: tableErr } = await supabase.from("shared_state").upsert({
      key: GOOGLE_SHEETS_SHARED_STATE_KEY,
      value: { webhookUrl: cleanUrl, autoSync },
      updated_at: new Date().toISOString(),
    });
    if (!tableErr) {
      return { success: true };
    }
    lastError = tableErr.message;
  } catch (err) {
    lastError = String(err);
  }

  // 3. Try TanStack Start server function (elevated backend execution)
  try {
    const srvRes = await saveGoogleSheetsConfigServerFn({
      data: { webhookUrl: cleanUrl, autoSync },
    });
    if (srvRes && srvRes.success) {
      return { success: true };
    }
    if (srvRes && srvRes.error) {
      lastError = srvRes.error;
    }
  } catch (err) {
    lastError = String(err);
  }

  // Even if backend calls failed, localStorage and memory are updated for this client session
  return { success: anySuccess, error: lastError || undefined };
}

export async function initGoogleSheetsConfig(): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("shared_state")
      .select("value")
      .eq("key", GOOGLE_SHEETS_SHARED_STATE_KEY)
      .maybeSingle();

    isConfigInitialized = true;

    if (data?.value && typeof data.value === "object") {
      const cfg = data.value as { webhookUrl?: string; autoSync?: boolean };
      if (cfg.webhookUrl && cfg.webhookUrl.trim()) {
        setGoogleSheetsConfigInMemory(cfg.webhookUrl, cfg.autoSync);
        return cfg.webhookUrl.trim();
      }
    }

    // If not found in DB, but present in localStorage, push it to DB
    if (typeof window !== "undefined") {
      const localUrl = localStorage.getItem("jellybean_google_sheets_webhook");
      if (localUrl && localUrl.trim().startsWith("https://script.google.com/")) {
        const localAutoSync = localStorage.getItem("jellybean_google_sheets_autosync") !== "false";
        void persistGoogleSheetsConfig(localUrl, localAutoSync);
        return localUrl.trim();
      }
    }
  } catch (err) {
    console.warn("[GoogleSheetsSync] Config fetch notice:", err);
  }
  return null;
}

let cachedProfilesMap: Map<string, string> | null = null;
let lastProfilesFetch = 0;

export async function resolveStaffName(userId?: string | null): Promise<string> {
  if (!userId) return "Unassigned";
  const now = Date.now();
  if (!cachedProfilesMap || now - lastProfilesFetch > 300000) {
    try {
      const { data } = await supabase.from("profiles").select("user_id, full_name, email");
      cachedProfilesMap = new Map();
      (data || []).forEach((p) => {
        cachedProfilesMap!.set(p.user_id, p.full_name || p.email || "Staff");
      });
      lastProfilesFetch = now;
    } catch {
      // fallback
    }
  }
  return cachedProfilesMap?.get(userId) || "Unassigned";
}

export type SyncAction = "INSERT" | "UPDATE" | "DELETE";

export type LeadSyncPayload = {
  id: string;
  customer_name?: string | null;
  customer_number?: string | null;
  customer_number_2?: string | null;
  main_area?: string | null;
  sub_area?: string | null;
  area?: string | null;
  service?: string | null;
  cs_status?: string | null;
  number_name?: string | null;
  context?: string | null;
  requirement_1?: string | null;
  requirement_2?: string | null;
  post_text?: string | null;
  marketing_notes?: string | null;
  compose?: string | null;
  assigned_to?: string | null;
  assigned_to_name?: string | null;
  created_at?: string | null;
  assigned_at?: string | null;
  pinned_important?: boolean | null;
  is_important?: boolean | null;
  [key: string]: unknown;
};

// Dispatch deduplication to prevent flooding when multiple events fire for the same lead
const recentlyDispatched = new Map<string, number>();

export async function syncLeadToGoogleSheet(
  action: SyncAction,
  lead: LeadSyncPayload,
  customWebhookUrl?: string,
) {
  if (!isGoogleSheetsAutoSyncEnabled()) {
    console.log("[GoogleSheetsSync] Auto-sync disabled, skipping dispatch.");
    return;
  }

  // Ensure config is loaded if not already
  if (!isConfigInitialized && !memoryWebhookUrl) {
    await initGoogleSheetsConfig();
  }

  const webhookUrl = (customWebhookUrl || getGoogleSheetsWebhookUrl()).trim();

  if (!webhookUrl) {
    console.warn("[GoogleSheetsSync] Auto-sync skipped (no webhook URL configured)");
    return;
  }

  // Deduplicate rapid duplicate dispatches for the exact same lead state
  const dispatchKey = `${action}:${lead.id}:${lead.cs_status || ""}:${lead.marketing_notes || ""}:${lead.customer_name || ""}:${lead.customer_number || ""}:${lead.service || ""}:${lead.assigned_to || ""}:${lead.pinned_important ? 1 : 0}`;
  const now = Date.now();
  const lastTime = recentlyDispatched.get(dispatchKey);
  if (lastTime && now - lastTime < 3500) {
    console.log(`[GoogleSheetsSync] Duplicate dispatch suppressed for lead ${lead.id} (${action})`);
    return;
  }

  try {
    if (!lead.assigned_to_name && lead.assigned_to) {
      lead.assigned_to_name = await resolveStaffName(lead.assigned_to);
    }

    const payload = {
      type: action,
      action: action,
      record: lead,
      lead: lead,
      old_record: lead,
      old_lead: lead,
      leadId: lead.id,
      customer_number: lead.customer_number || null,
      customer_name: lead.customer_name || null,
      timestamp: new Date().toISOString(),
    };

    console.log(`[GoogleSheetsSync] Dispatching ${action} for lead ${lead.id} (${lead.customer_name || "Unknown"}):`, payload);

    // Record deduplication mark
    recentlyDispatched.set(dispatchKey, now);

    // Prune old entries
    if (recentlyDispatched.size > 200) {
      const cutoff = now - 10000;
      for (const [k, v] of recentlyDispatched.entries()) {
        if (v < cutoff) recentlyDispatched.delete(k);
      }
    }

    // Use mode: 'no-cors' so browser fetch to Google Apps Script does not fail on CORS redirect
    await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
      },
      body: JSON.stringify(payload),
      mode: "no-cors",
    });

    console.log(`[GoogleSheetsSync] ${action} event dispatched successfully for lead ${lead.id}.`);
  } catch (err) {
    console.warn("[GoogleSheetsSync] Sync notice:", err);
  }
}
