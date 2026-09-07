/**
 * Jellybean CRM -> Google Sheets Sync Dispatcher
 * Dispatches INSERT, UPDATE, and DELETE events to Google Apps Script Webhook.
 */
import { supabase } from "@/integrations/supabase/client";

export const GOOGLE_SHEETS_SHARED_STATE_KEY = "google_sheets_sync_config";

const DEFAULT_WEBHOOK_URL =
  "https://script.google.com/macros/s/AKfycbxCk4Vf4CN4-SfNe1Q2EX-oTHC2LRCGey6rXBrL11bIEKQA1kZAdx85PbxUGDwHR_N2/exec";

let memoryWebhookUrl: string | null = null;
let memoryAutoSync: boolean | null = null;

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
    memoryWebhookUrl = url.trim();
    if (typeof window !== "undefined") {
      localStorage.setItem("jellybean_google_sheets_webhook", url.trim());
    }
  }
  if (autoSync !== undefined) {
    memoryAutoSync = autoSync;
    if (typeof window !== "undefined") {
      localStorage.setItem("jellybean_google_sheets_autosync", String(autoSync));
    }
  }
}

export async function initGoogleSheetsConfig() {
  try {
    const { data } = await supabase
      .from("shared_state")
      .select("value")
      .eq("key", GOOGLE_SHEETS_SHARED_STATE_KEY)
      .maybeSingle();

    if (data?.value && typeof data.value === "object") {
      const cfg = data.value as { webhookUrl?: string; autoSync?: boolean };
      if (cfg.webhookUrl) {
        setGoogleSheetsConfigInMemory(cfg.webhookUrl, cfg.autoSync);
      }
    }
  } catch (err) {
    console.warn("[GoogleSheetsSync] Config fetch notice:", err);
  }
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
  assigned_to?: string | null;
  assigned_to_name?: string | null;
  created_at?: string | null;
  assigned_at?: string | null;
  pinned_important?: boolean | null;
  is_important?: boolean | null;
  [key: string]: unknown;
};

export async function syncLeadToGoogleSheet(
  action: SyncAction,
  lead: LeadSyncPayload,
  customWebhookUrl?: string,
) {
  const webhookUrl = (customWebhookUrl || getGoogleSheetsWebhookUrl()).trim();

  if (!webhookUrl || !isGoogleSheetsAutoSyncEnabled()) {
    console.warn("[GoogleSheetsSync] Auto-sync skipped (no webhook URL or sync disabled)");
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

    // Use mode: 'no-cors' so browser fetch to Google Apps Script does not fail on CORS redirect
    await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
      },
      body: JSON.stringify(payload),
      mode: "no-cors",
    });

    console.log(`[GoogleSheetsSync] ${action} event dispatched successfully.`);
  } catch (err) {
    console.warn("[GoogleSheetsSync] Sync notice:", err);
  }
}
