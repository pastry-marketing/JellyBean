import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const saveGoogleSheetsConfigServerFn = createServerFn({ method: "POST" })
  .inputValidator((input: { webhookUrl: string; autoSync?: boolean }) => input)
  .handler(async ({ data }) => {
    try {
      const url = (data.webhookUrl || "").trim();
      const autoSync = data.autoSync !== false;

      const { error } = await supabaseAdmin.from("shared_state").upsert({
        key: "google_sheets_sync_config",
        value: { webhookUrl: url, autoSync },
        updated_at: new Date().toISOString(),
      });

      if (error) {
        return { success: false, error: error.message };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
