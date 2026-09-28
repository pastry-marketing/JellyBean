// Shared draft storage for Raw Leads and Manual Leads forwarding forms.
// One table (public.lead_drafts) backs both flows. RLS on the DB enforces
// per-user ownership — this helper does not weaken those checks.

import { supabase } from "@/integrations/supabase/client";

export type DraftSourceType = "raw_lead" | "manual_lead";

// The full set of values captured from the LeadForm plus a snapshot of any
// context the reopen flow needs (e.g. the underlying raw lead entry for
// raw_lead drafts). Kept as a loose shape so future fields don't require a
// migration.
export type DraftFormData = {
  customerName?: string;
  customerNumber?: string;
  extraNumbers?: string[];
  area?: string;
  service?: string;
  context?: string;
  exactCustomerText?: string;
  reference?: string;
  isImportant?: boolean;
  originalLeadLink?: string | null;
  // Raw Leads: snapshot of the CacheEntry so we can reopen the qualify
  // dialog even if the caller doesn't currently have that row in memory.
  entrySnapshot?: unknown;
  // Manual leads: role at the time of drafting.
  role?: string;
  // Any additional forward-compatible values.
  [key: string]: unknown;
};

export type LeadDraft = {
  id: string;
  source_type: DraftSourceType;
  source_lead_id: string | null;
  form_data: DraftFormData;
  created_by: string;
  created_at: string;
  updated_at: string;
};

// The lead_drafts table is not yet in the generated types file; cast the
// client narrowly here so callers get proper types without leaking `any`.
type DraftClient = {
  from: (table: "lead_drafts") => {
    select: (cols: string) => {
      eq: (
        col: string,
        val: string,
      ) => {
        order: (
          col: string,
          opts: { ascending: boolean },
        ) => Promise<{
          data: LeadDraft[] | null;
          error: { message: string } | null;
        }>;
      };
    };
    insert: (row: Partial<LeadDraft>) => {
      select: () => {
        single: () => Promise<{ data: LeadDraft | null; error: { message: string } | null }>;
      };
    };
    update: (row: Partial<LeadDraft>) => {
      eq: (
        col: string,
        val: string,
      ) => {
        eq: (
          col: string,
          val: string,
        ) => {
          select: () => {
            single: () => Promise<{ data: LeadDraft | null; error: { message: string } | null }>;
          };
        };
      };
    };
    upsert: (
      row: Partial<LeadDraft>,
      opts: { onConflict: string },
    ) => {
      select: () => {
        single: () => Promise<{ data: LeadDraft | null; error: { message: string } | null }>;
      };
    };
    delete: () => {
      eq: (col: string, val: string) => Promise<{ error: { message: string } | null }>;
    };
  };
};

function client(): DraftClient {
  return supabase as unknown as DraftClient;
}

export async function listMyDrafts(userId: string): Promise<LeadDraft[]> {
  const { data, error } = await client()
    .from("lead_drafts")
    .select("*")
    .eq("created_by", userId)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

// Lightweight HEAD count of the current user's drafts. Optionally filtered by
// source_type so a page can show a red-dot indicator without loading rows.
export async function countMyDrafts(userId: string, sourceType?: DraftSourceType): Promise<number> {
  const anyClient = supabase as unknown as {
    from: (t: string) => {
      select: (
        cols: string,
        opts: { count: "exact" | "planned"; head: boolean },
      ) => {
        eq: (
          c: string,
          v: string,
        ) => {
          eq: (
            c: string,
            v: string,
          ) => Promise<{ count: number | null; error: { message: string } | null }>;
        } & Promise<{ count: number | null; error: { message: string } | null }>;
      };
    };
  };
  const base = anyClient
    .from("lead_drafts")
    .select("id", { count: "exact", head: true })
    .eq("created_by", userId);
  const { count, error } = sourceType ? await base.eq("source_type", sourceType) : await base;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function saveDraft(input: {
  id?: string | null;
  source_type: DraftSourceType;
  source_lead_id: string | null;
  form_data: DraftFormData;
  created_by: string;
}): Promise<LeadDraft> {
  // Explicit id (reopened draft): update in place, preserves created_at.
  if (input.id) {
    const { data, error } = await client()
      .from("lead_drafts")
      .update({ form_data: input.form_data })
      .eq("id", input.id)
      .eq("created_by", input.created_by)
      .select()
      .single();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("Draft not found");
    return data;
  }

  // Raw leads (source_lead_id present): upsert on the composite unique key,
  // so a second save for the same lead updates the existing row.
  if (input.source_lead_id) {
    const { data, error } = await client()
      .from("lead_drafts")
      .upsert(
        {
          source_type: input.source_type,
          source_lead_id: input.source_lead_id,
          form_data: input.form_data,
          created_by: input.created_by,
        },
        { onConflict: "created_by,source_type,source_lead_id" },
      )
      .select()
      .single();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("Failed to save draft");
    return data;
  }

  // Manual leads without a source id: create a new draft row.
  const { data, error } = await client()
    .from("lead_drafts")
    .insert({
      source_type: input.source_type,
      source_lead_id: null,
      form_data: input.form_data,
      created_by: input.created_by,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Failed to save draft");
  return data;
}

export async function deleteDraft(id: string): Promise<void> {
  const { error } = await client().from("lead_drafts").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// Best-effort cleanup after a successful send. Deletes by id when known,
// otherwise by (source_type, source_lead_id) for the current user. Missing
// draft is not an error.
export async function deleteDraftForSource(params: {
  userId: string;
  draftId?: string | null;
  source_type: DraftSourceType;
  source_lead_id: string | null;
}): Promise<void> {
  if (params.draftId) {
    try {
      await deleteDraft(params.draftId);
    } catch {
      // best-effort
    }
    return;
  }
  if (!params.source_lead_id) return;
  const anyClient = supabase as unknown as {
    from: (t: string) => {
      delete: () => {
        eq: (
          c: string,
          v: string,
        ) => {
          eq: (
            c: string,
            v: string,
          ) => {
            eq: (c: string, v: string) => Promise<{ error: unknown }>;
          };
        };
      };
    };
  };
  try {
    await anyClient
      .from("lead_drafts")
      .delete()
      .eq("created_by", params.userId)
      .eq("source_type", params.source_type)
      .eq("source_lead_id", params.source_lead_id);
  } catch {
    // best-effort
  }
}
