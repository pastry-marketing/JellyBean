import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logActivity } from "@/lib/activity-log";
import { DEFAULT_CS_COMPOSE_TEMPLATE } from "@/lib/cs-compose-template";
import { DEFAULT_CS_REPHRASE_PROMPT, type CsComposeInput } from "@/lib/cs-compose";
import { composeCsLead } from "@/lib/cs-compose.server";

// FROZEN PROMPT — batch-aware default used when no saved CRM prompt is available.
export const FROZEN_LEAD_PROMPT = `You classify each item in the \`leads\` array independently as a residential home-service lead.

For every input ID, return a \`yes\` or \`no\` decision using the required response schema.

YES means the author currently needs, wants, or is seeking someone to perform an included service at a home or residential property.

YES includes:
- Hiring or looking for a provider
- Asking for a recommendation, referral, estimate, or quote
- Describing a current home problem that normally requires professional help
- Repair, diagnosis, installation, replacement, maintenance, improvement, remodeling, moving, junk removal, hauling, or heavy one-time cleanup

Included services include handyman, plumbing, electrical, HVAC, roofing, gutters, flooring, drywall, painting, doors, windows, garage doors, fences, concrete, appliances, sprinklers, pools, remodeling, moving, junk removal, pest control, locksmith, tree removal or trimming, pressure washing, storm cleanup, hoarder cleanup, estate cleanout, and similar residential work.

NO means:
- The author is advertising or offering their own services
- The service has already been completed and no additional work is requested
- The author only wants DIY advice, products, supplies, moving boxes, or a disposal location
- The requested service is routine house cleaning, cooking, catering, beauty, child care, pet care, lawn mowing, routine landscaping, car repair, employment, rentals, events, or unrelated discussion

Important:
- Classify the author's intent, not isolated keywords.
- A current broken or malfunctioning home item is YES even without the words "hire," "recommend," or "looking for."
- "My AC stopped cooling" is YES.
- "I repair AC systems—call me" is NO.
- "I need movers" is YES.
- "I need moving boxes" is NO.
- If a post clearly contains both qualifying and unrelated requests, choose YES.
- When a post may reasonably be a qualifying residential-service need, choose YES.
- Do not allow one post in the batch to influence another post.`;

const analyzeInputSchema = z.object({
  // Accepted for backward-compat; if omitted the frozen default is used.
  prompt: z.string().optional(),
  rowKeys: z.array(z.string().min(1)).min(1).max(50),
});

type LeadDecision = "yes" | "no";

type RawLeadAiResult = {
  row_key: string;
  lead: LeadDecision;
};

// Nano models handle small batches more reliably. 10 keeps id-mapping tight.
const OPENAI_BATCH_SIZE = 10;
const MAX_POST_TEXT_CHARS = 1500;
const PRIMARY_MODEL = "gpt-5.4-nano-2026-03-17";

type OpenAiResponse = {
  id?: string;
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
      type?: string;
    }>;
  }>;
  // Chat Completions shape
  choices?: Array<{
    message?: { content?: string | null; refusal?: string | null; role?: string };
    finish_reason?: string;
  }>;
  error?: {
    message?: string;
  };
};

async function ensureRequesterCanAnalyze(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["admin", "sub_admin", "maturing"]);

  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Forbidden: Raw Leads access required");
}

async function loadActor(userId: string) {
  const [{ data: profile }, { data: roleRow }] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("full_name, username, email")
      .eq("user_id", userId)
      .maybeSingle(),
    supabaseAdmin.from("user_roles").select("role").eq("user_id", userId).limit(1).maybeSingle(),
  ]);

  return {
    name: profile?.full_name || profile?.username || profile?.email || null,
    role: roleRow?.role ?? null,
  };
}

// Extracts completion text from OpenAI chat completions or legacy responses output
function extractOutputText(response: OpenAiResponse) {
  // Chat Completions (what this function calls) returns choices[].message.content
  const choice = response.choices?.[0];
  if (choice?.message?.refusal) {
    throw new Error(`OpenAI refused the request: ${choice.message.refusal}`);
  }
  const chatText = choice?.message?.content?.trim();
  if (chatText) return chatText;

  // Responses API fallback
  if (response.output_text) return response.output_text;

  const parts: string[] = [];
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function trimForAi(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_POST_TEXT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_POST_TEXT_CHARS)}...`;
}

// Strict parser + completeness validator. Throws on any anomaly rather than
// silently dropping a lead or defaulting a missing result to "no".
export function parseAndValidateAiResults(text: string, rowKeys: string[]): RawLeadAiResult[] {
  let parsed: { results?: Array<{ id?: unknown; lead?: unknown }> };
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`AI response is not valid JSON: ${(e as Error).message}`);
  }

  const results = parsed.results;
  if (!Array.isArray(results)) {
    throw new Error("AI response missing 'results' array");
  }

  const expectedIds = new Set(rowKeys.map((_, i) => String(i + 1)));
  const seen = new Set<string>();
  const out: RawLeadAiResult[] = [];

  for (const item of results) {
    if (typeof item.id !== "string" || !expectedIds.has(item.id)) {
      throw new Error(`AI returned unexpected or missing id: ${JSON.stringify(item.id)}`);
    }
    if (seen.has(item.id)) {
      throw new Error(`AI returned duplicate id: ${item.id}`);
    }
    if (item.lead !== "yes" && item.lead !== "no") {
      throw new Error(
        `AI returned invalid decision for id ${item.id}: ${JSON.stringify(item.lead)}`,
      );
    }
    seen.add(item.id);
    out.push({ row_key: rowKeys[Number(item.id) - 1], lead: item.lead });
  }

  if (seen.size !== rowKeys.length) {
    const missing = [...expectedIds].filter((id) => !seen.has(id));
    throw new Error(`AI response incomplete — missing ids: ${missing.join(", ")}`);
  }

  return out;
}

async function classifyWithOpenAi({
  systemPrompt,
  leads,
  model,
}: {
  systemPrompt: string;
  leads: Array<{ id: string; postText: string }>;
  model: string;
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY secret");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify({ leads }) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "raw_lead_classification",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string" },
                    lead: { type: "string", enum: ["yes", "no"] },
                  },
                  required: ["id", "lead"],
                },
              },
            },
            required: ["results"],
          },
        },
      },
    }),
  });

  const body = (await response.json()) as OpenAiResponse;
  const openaiRequestId =
    response.headers.get("x-request-id") ?? response.headers.get("openai-request-id") ?? null;

  console.log("[raw-leads-ai] OpenAI response", {
    model,
    status: response.status,
    ok: response.ok,
    batchSize: leads.length,
    requestedCount: leads.length,
    openaiResponseId: body.id ?? null,
    openaiRequestId,
    error: body.error?.message ?? null,
  });

  if (!response.ok) {
    throw new Error(body.error?.message ?? `OpenAI request failed (${response.status})`);
  }

  const text = extractOutputText(body);
  if (!text) {
    throw new Error(
      `OpenAI returned an empty response (finish_reason: ${body.choices?.[0]?.finish_reason ?? "unknown"})`,
    );
  }
  return text;
}

async function classifyBatch({
  systemPrompt,
  batch,
}: {
  systemPrompt: string;
  batch: Array<{ rowKey: string; id: string; postText: string }>;
}): Promise<RawLeadAiResult[]> {
  const text = await classifyWithOpenAi({
    systemPrompt,
    model: PRIMARY_MODEL,
    leads: batch.map(({ id, postText }) => ({ id, postText: trimForAi(postText) })),
  });
  const rowKeys = batch.map((lead) => lead.rowKey);
  const results = parseAndValidateAiResults(text, rowKeys);
  console.log("[raw-leads-ai] batch validated", {
    requested: batch.length,
    returned: results.length,
    complete: results.length === batch.length,
  });
  return results;
}

export const analyzeRawLeadsWithAi = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => analyzeInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    await ensureRequesterCanAnalyze(context.userId);

    const orderedKeys = [...new Set(data.rowKeys)].slice(0, 50);

    // Chunk the .in() lookup — long row_keys can push the PostgREST GET URL
    // past its length limit and surface as a generic "Bad Request".
    const CHUNK = 10;
    const rows: Array<{ row_key: string; data: unknown; duplicate_detected: boolean | null }> = [];
    for (let i = 0; i < orderedKeys.length; i += CHUNK) {
      const slice = orderedKeys.slice(i, i + CHUNK);
      const { data: part, error } = await supabaseAdmin
        .from("raw_lead_cache")
        .select("row_key, data, duplicate_detected")
        .in("row_key", slice);
      if (error) throw new Error(error.message);
      if (part) rows.push(...part);
    }

    const byKey = new Map(rows.map((row) => [row.row_key, row]));
    const leads = orderedKeys
      .map((rowKey) => {
        const row = byKey.get(rowKey);
        const payload = (row?.data ?? {}) as Record<string, string | null | undefined>;
        return {
          rowKey,
          postText: payload["Post Text"] ?? "",
          isDuplicate: row?.duplicate_detected === true,
        };
      })
      // Skip duplicates — no point spending AI credits classifying them.
      .filter((lead) => !lead.isDuplicate)
      // Posts under 20 chars are too short for reliable AI classification.
      .filter((lead) => lead.postText.trim().length >= 20);

    if (leads.length === 0) throw new Error("No selected raw leads have post text to analyze");

    const systemPrompt = data.prompt?.trim() || FROZEN_LEAD_PROMPT;
    const results: RawLeadAiResult[] = [];
    for (let i = 0; i < leads.length; i += OPENAI_BATCH_SIZE) {
      const slice = leads.slice(i, i + OPENAI_BATCH_SIZE);
      const batch = slice.map((lead, idx) => ({
        rowKey: lead.rowKey,
        id: String(idx + 1),
        postText: lead.postText,
      }));
      const batchResults = await classifyBatch({ systemPrompt, batch });
      results.push(...batchResults);
    }

    if (results.length === 0) throw new Error("AI returned no usable lead decisions");

    const { error: updateError } = await supabaseAdmin.rpc("batch_update_raw_lead_decisions", {
      decisions: results.map(({ row_key, lead }) => ({ row_key, lead })),
    });
    if (updateError) throw new Error(updateError.message);

    const yes = results.filter((result) => result.lead === "yes").length;
    const no = results.filter((result) => result.lead === "no").length;
    const review = 0;
    const actor = await loadActor(context.userId);
    await logActivity({
      supabaseAdmin,
      actorId: context.userId,
      actorName: actor.name,
      actorRole: actor.role,
      action: "ai_classify",
      entityType: "raw_lead_cache",
      metadata: { analyzed: results.length, yes, no, review },
    });

    return {
      ok: true,
      analyzed: results.length,
      yes,
      no,
      review,
      results,
    };
  });

export const checkOpenAiConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .in("role", ["admin", "sub_admin"]);
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Error("Forbidden: admin only");

    return { configured: !!process.env.OPENAI_API_KEY };
  });

async function ensureRequesterCanRephrase(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", [
      "admin",
      "sub_admin",
      "cs",
      "cs_admin",
      "scraping",
      "maturing",
      "acc_handler",
      "facebook",
      "seo",
    ]);

  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Forbidden: Access required");
}

const rephraseInputSchema = z.object({
  template: z.string().max(5000),
  customerName: z.string().max(300),
  service: z.string().max(500).nullable().optional(),
  contextText: z.string().max(10000).nullable().optional(),
  postText: z.string().max(10000).nullable().optional(),
  requirement1: z.string().max(2000).nullable().optional(),
  requirement2: z.string().max(2000).nullable().optional(),
  systemPrompt: z.string().max(30000).nullable().optional(),
});

async function loadCsComposeSettings(client: Pick<typeof supabaseAdmin, "from">) {
  const { data, error } = await client
    .from("shared_state")
    .select("key, value")
    .in("key", ["cs_rephrase_prompt", "cs_compose_templates_list", "cs_auto_rephrase_enabled"]);
  if (error) throw new Error(error.message);
  const values = Object.fromEntries((data || []).map((row) => [row.key, row.value])) as Record<
    string,
    unknown
  >;
  const prompt = values.cs_rephrase_prompt as { text?: unknown } | undefined;
  const templates = values.cs_compose_templates_list as
    | { templates?: Array<{ template?: unknown }> }
    | undefined;
  const toggle = values.cs_auto_rephrase_enabled as { enabled?: unknown } | undefined;
  const configuredTemplate = Array.isArray(templates?.templates)
    ? templates.templates.find((item) => typeof item?.template === "string" && item.template.trim())
        ?.template
    : undefined;
  return {
    prompt:
      typeof prompt?.text === "string" && prompt.text.trim()
        ? prompt.text
        : DEFAULT_CS_REPHRASE_PROMPT,
    template:
      typeof configuredTemplate === "string" ? configuredTemplate : DEFAULT_CS_COMPOSE_TEMPLATE,
    enabled: toggle?.enabled === true,
  };
}

// Kept for callers that only need the composed text.
export async function executeAiRephraseCore(input: CsComposeInput): Promise<string> {
  return (await composeCsLead(input)).rephrased;
}

export const rephraseLeadTemplateWithAi = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => rephraseInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    await ensureRequesterCanRephrase(context.userId);
    const settings = await loadCsComposeSettings(context.supabase);
    return composeCsLead({ ...data, systemPrompt: data.systemPrompt?.trim() || settings.prompt });
  });

export const autoRephraseLeadWithAi = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ leadId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const client = context.supabase;
    const settings = await loadCsComposeSettings(client);
    if (!settings.enabled) return { success: false, reason: "Auto-rephrase is disabled" };
    if (!process.env.OPENAI_API_KEY) return { success: false, reason: "Missing OPENAI_API_KEY" };

    // Use the caller's RLS access for both read and write. Automatic composition
    // is limited to new incoming leads and never regenerates processed messages.
    const { data: lead, error } = await client
      .from("qualified_leads")
      .select(
        "id, customer_name, service, context, post_text, requirement_1, requirement_2, marketing_notes, updated_at, cs_status",
      )
      .eq("id", data.leadId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!lead) return { success: false, reason: "Lead not found or not accessible" };
    if (lead.cs_status !== "new")
      return { success: false, reason: "Only new leads are composed automatically" };
    if (lead.marketing_notes?.trim())
      return { success: false, reason: "Already has marketing_notes" };
    if (!lead.post_text?.trim() && !lead.context?.trim())
      return { success: false, reason: "No customer post or context" };

    const result = await composeCsLead({
      template: settings.template,
      customerName: lead.customer_name || "there",
      service: lead.service,
      contextText: lead.context,
      postText: lead.post_text,
      requirement1: lead.requirement_1,
      requirement2: lead.requirement_2,
      systemPrompt: settings.prompt,
    });
    if (!(await loadCsComposeSettings(client)).enabled) {
      return { success: false, reason: "Auto-rephrase was turned off while composing" };
    }
    // A simultaneous manual edit or another automatic request wins. Do not
    // overwrite a message or source that changed during generation/review.
    let update = client
      .from("qualified_leads")
      .update({
        marketing_notes: result.rephrased,
        requirement_1: result.requirement1 || null,
        requirement_2: result.requirement2 || null,
      })
      .eq("id", lead.id)
      .eq("updated_at", lead.updated_at)
      .eq("cs_status", "new");
    update =
      lead.marketing_notes === null
        ? update.is("marketing_notes", null)
        : update.eq("marketing_notes", lead.marketing_notes);
    const { data: saved, error: saveError } = await update.select("id").maybeSingle();
    if (saveError) throw new Error(saveError.message);
    if (!saved)
      return {
        success: false,
        reason: "Lead changed while composing; existing data was preserved",
      };
    return { success: true, ...result };
  });
