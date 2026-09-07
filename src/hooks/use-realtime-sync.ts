import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { AppRole } from "@/hooks/use-auth";
import {
  syncLeadToGoogleSheet,
  initGoogleSheetsConfig,
  setGoogleSheetsConfigInMemory,
  GOOGLE_SHEETS_SHARED_STATE_KEY,
  type LeadSyncPayload,
} from "@/lib/google-sheets-sync";

// Map each replicated table to the React Query keys that should refresh
// when any user inserts/updates a row.
const TABLE_QUERY_KEYS: Record<string, string[][]> = {
  qualified_leads: [["cs_leads"], ["cs_sent_today"], ["forwarded-leads"]],
  incogniton_profiles: [["incog_profiles"]],
  shared_state: [["raw-leads-shared-start-row"], ["raw-leads-ai-lock"], ["lead-ai-prompt"]],
};

const ROLE_TABLES: Record<AppRole, string[]> = {
  admin: ["qualified_leads", "incogniton_profiles", "shared_state"],
  sub_admin: ["qualified_leads", "incogniton_profiles", "shared_state"],
  scraping: ["qualified_leads", "incogniton_profiles", "shared_state"],
  maturing: ["qualified_leads", "incogniton_profiles", "shared_state"],
  cs: ["qualified_leads", "shared_state"],
  cs_admin: ["qualified_leads", "shared_state"],
  acc_handler: ["incogniton_profiles", "shared_state"],
  facebook: ["qualified_leads", "shared_state"],
  seo: ["qualified_leads", "shared_state"],
};

function makeDebouncedInvalidator(qc: QueryClient, waitMs = 400) {
  const pending = new Set<string>();
  return (key: string[]) => {
    const id = key.join("/");
    if (pending.has(id)) return;
    pending.add(id);
    setTimeout(() => {
      pending.delete(id);
      qc.invalidateQueries({ queryKey: key });
    }, waitMs);
  };
}

export function useRealtimeSync(role: AppRole | null) {
  const qc = useQueryClient();
  const invalidateRef = useRef<((key: string[]) => void) | null>(null);

  useEffect(() => {
    invalidateRef.current = makeDebouncedInvalidator(qc, 400);
    void initGoogleSheetsConfig();
  }, [qc]);

  useEffect(() => {
    if (!role) return;
    const tables = ROLE_TABLES[role] || [];
    if (tables.length === 0) return;

    const channel = supabase.channel("crm-realtime-sync");

    for (const table of tables) {
      if (table === "qualified_leads") {
        // Full listener for qualified_leads: INSERT, UPDATE, DELETE with Google Sheets sync
        (channel as unknown as { on: (...args: unknown[]) => typeof channel }).on(
          "postgres_changes",
          { event: "*", schema: "public", table: "qualified_leads" },
          (payload: {
            eventType: "INSERT" | "UPDATE" | "DELETE";
            new?: Record<string, unknown>;
            old?: Record<string, unknown>;
          }) => {
            const invalidate = invalidateRef.current;
            if (invalidate) {
              for (const key of TABLE_QUERY_KEYS.qualified_leads) invalidate(key);
            }

            // Sync with Google Sheets automatically in the background
            try {
              if (payload.eventType === "DELETE") {
                const id = String(payload.old?.id || "");
                if (id) {
                  void syncLeadToGoogleSheet("DELETE", {
                    id,
                    customer_number: (payload.old?.customer_number as string) || null,
                    customer_name: (payload.old?.customer_name as string) || null,
                  });
                }
              } else if (payload.new && payload.new.id) {
                void syncLeadToGoogleSheet(
                  payload.eventType,
                  payload.new as unknown as LeadSyncPayload,
                );
              }
            } catch (err) {
              console.warn("[RealtimeGoogleSheetsSync] Error:", err);
            }
          },
        );
      } else if (table === "shared_state") {
        (channel as unknown as { on: (...args: unknown[]) => typeof channel }).on(
          "postgres_changes",
          { event: "*", schema: "public", table: "shared_state" },
          (payload: {
            eventType: string;
            new?: { key?: string; value?: unknown };
          }) => {
            if (payload.new?.key === GOOGLE_SHEETS_SHARED_STATE_KEY) {
              const cfg = payload.new.value as { webhookUrl?: string; autoSync?: boolean } | undefined;
              if (cfg && typeof cfg === "object") {
                setGoogleSheetsConfigInMemory(cfg.webhookUrl, cfg.autoSync);
              }
            }
            const invalidate = invalidateRef.current;
            if (!invalidate) return;
            for (const key of TABLE_QUERY_KEYS[table] ?? []) invalidate(key);
          },
        );
      } else {
        for (const event of ["INSERT", "UPDATE"] as const) {
          (channel as unknown as { on: (...args: unknown[]) => typeof channel }).on(
            "postgres_changes",
            { event, schema: "public", table },
            () => {
              const invalidate = invalidateRef.current;
              if (!invalidate) return;
              for (const key of TABLE_QUERY_KEYS[table] ?? []) invalidate(key);
            },
          );
        }
      }
    }

    channel.subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [role, qc]);
}
