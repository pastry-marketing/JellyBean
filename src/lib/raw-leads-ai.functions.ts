import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logActivity } from "@/lib/activity-log";
import { DEFAULT_CS_COMPOSE_TEMPLATE } from "@/lib/cs-compose-template";

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
export function parseAndValidateAiResults(
  text: string,
  rowKeys: string[],
): RawLeadAiResult[] {
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
      throw new Error(`AI returned invalid decision for id ${item.id}: ${JSON.stringify(item.lead)}`);
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
  template: z.string(),
  customerName: z.string(),
  contextText: z.string().nullable().optional(),
  requirement1: z.string().nullable().optional(),
  requirement2: z.string().nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
});

export async function executeAiRephraseCore({
  template,
  customerName,
  contextText,
  requirement1,
  requirement2,
  systemPrompt: customSystemPrompt,
}: {
  template: string;
  customerName: string;
  contextText?: string | null;
  requirement1?: string | null;
  requirement2?: string | null;
  systemPrompt?: string | null;
}): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY secret");

  const defaultSystemPrompt = `You are an expert customer service assistant. Your goal is to clean, extract, and normalize three parts of a customer lead request to prepare them for an outbound message.

You must output a JSON object containing exactly three fields:
1. "serviceContext": A very short, clean name of the service (e.g. "garage door repair", "lawn care", "plumbing leak"). It must be concise and lowercase. Never use "service", "seeking", "repair or replacement", or "damaged or non-functioning".
2. "requirement1": The first requirement or question normalized as an action-oriented phrase starting with a lowercase verb.
3. "requirement2": The second requirement or question normalized as an action-oriented phrase starting with a lowercase verb.

Normalization Rules for Requirements (both requirement1 and requirement2):
- If the requirement refers to address, location, or where to go, normalize it to: "share your complete address"
- If the requirement refers to availability, time, or when they are available, normalize it to: "let me know your availability"
- If the requirement refers to a photo, picture, image, or snapshot, normalize it to: "send me a picture of it"
- Otherwise, rephrase to start with a verb (e.g. "confirm whether you have the spring on hand").
- Requirement text must not be capitalized or end with punctuation.

Forbidden Phrases (do not use in any field):
- "I understand"
- "seeking"
- "repair or replacement"
- "damaged or non-functioning"
- "provide the service address"
- "our schedule"
- "arrange a visit"`;

  const systemPrompt = customSystemPrompt || defaultSystemPrompt;

  const userContent = JSON.stringify({
    context: contextText || "",
    requirement1: requirement1 || "",
    requirement2: requirement2 || "",
  });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "lead_rephrase",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              serviceContext: { type: "string" },
              requirement1: { type: "string" },
              requirement2: { type: "string" },
            },
            required: ["serviceContext", "requirement1", "requirement2"],
          },
        },
      },
    }),
  });

  const responseBody = await response.json();
  if (!response.ok) {
    throw new Error(responseBody.error?.message ?? `OpenAI request failed (${response.status})`);
  }

  const rephrased = responseBody.choices?.[0]?.message?.content || "";

  // Parse the JSON output from AI
  let serviceContext = "";
  let req1 = "";
  let req2 = "";

  try {
    const parsed = JSON.parse(rephrased.trim());
    serviceContext = parsed.serviceContext || "";
    req1 = parsed.requirement1 || "";
    req2 = parsed.requirement2 || "";
  } catch {
    // Fallback in case JSON parsing fails
    serviceContext = contextText || "";
    req1 = requirement1 || "";
    req2 = requirement2 || "";
  }

  // Helper functions for sanitization & normalization
  const extractFirstName = (fullName: string): string => {
    const name = fullName.trim().split(/\s+/)[0];
    return name || "there";
  };

  const extractSenderName = (templateText: string): string => {
    const match = templateText.match(/this is\s+([A-Za-z0-9_'\-\s]+?)(?:[\.,\r\n]|$)/i);
    if (match) {
      return match[1].trim();
    }
    const match2 = templateText.match(/this is\s+(\w+)/i);
    if (match2) {
      return match2[1].trim();
    }
    return "Alex";
  };

  const sanitizeForbiddenPhrases = (text: string): string => {
    if (!text) return "";
    let clean = text;
    const replacements: Array<[RegExp, string]> = [
      [/I understand/gi, ""],
      [/seeking/gi, "looking for"],
      [/repair or replacement/gi, "repair"],
      [/damaged or non-functioning/gi, ""],
      [/provide the service address/gi, "share your complete address"],
      [/our schedule/gi, "the schedule"],
      [/arrange a visit/gi, "check the schedule for a visit"],
    ];
    for (const [regex, rep] of replacements) {
      clean = clean.replace(regex, rep);
    }
    return clean.replace(/\s+/g, " ").trim();
  };

  const normalizeRequirement = (req: string): string => {
    if (!req) return "";
    let clean = req.trim();
    const lower = clean.toLowerCase();

    if (lower.includes("address")) {
      return "share your complete address";
    }
    if (
      lower.includes("availability") ||
      lower.includes("available") ||
      lower.includes("time") ||
      lower.includes("when")
    ) {
      return "let me know your availability";
    }
    if (
      lower.includes("photo") ||
      lower.includes("picture") ||
      lower.includes("image") ||
      lower.includes("pic")
    ) {
      return "send me a picture of it";
    }

    clean = sanitizeForbiddenPhrases(clean);
    if (clean.length > 0) {
      clean = clean.charAt(0).toLowerCase() + clean.slice(1);
      clean = clean.replace(/[\.\?,;!]$/, "");
    }
    return clean.trim();
  };

  const normalizeServiceContext = (ctx: string): string => {
    if (!ctx) return "your service";
    let clean = ctx.trim();
    clean = sanitizeForbiddenPhrases(clean);
    // Remove trailing/leading "service"
    clean = clean.replace(/\b(service)\b/gi, "");

    // If there is a "for [noun]" or "to [verb]" that repeats words present earlier in the string, strip it.
    const forIndex = clean.toLowerCase().indexOf(" for ");
    if (forIndex !== -1) {
      const firstPart = clean.substring(0, forIndex).trim();
      const secondPart = clean.substring(forIndex + 5).trim();
      const firstWords = firstPart
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2);
      const secondWords = secondPart
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2);
      const overlap = firstWords.some((w) => secondWords.includes(w));
      if (overlap) {
        clean = firstPart;
      }
    }

    clean = clean.replace(/\s+/g, " ").trim();
    if (clean.length > 0) {
      clean = clean.charAt(0).toLowerCase() + clean.slice(1);
    }
    return clean || "your service";
  };

  // Apply sanitization and normalization
  const finalFirstName = extractFirstName(customerName);
  const finalSenderName = extractSenderName(template);
  const finalServiceContext = normalizeServiceContext(serviceContext);
  const finalReq1 = normalizeRequirement(req1);
  const finalReq2 = normalizeRequirement(req2);

  // Build requirements part: join with " and " if both are present
  let requirementsPart = "";
  if (finalReq1 && finalReq2) {
    requirementsPart = `${finalReq1} and ${finalReq2}`;
  } else if (finalReq1) {
    requirementsPart = finalReq1;
  } else if (finalReq2) {
    requirementsPart = finalReq2;
  } else {
    requirementsPart = "confirm the details";
  }

  // Build the final strict SMS format
  const finalSms = `Hi ${finalFirstName}, this is ${finalSenderName}. I saw that you are looking for ${finalServiceContext}. Could you kindly ${requirementsPart}, so I can check the schedule for a visit?`;

  return finalSms;
}

export const rephraseLeadTemplateWithAi = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => rephraseInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    await ensureRequesterCanRephrase(context.userId);
    const finalSms = await executeAiRephraseCore({
      template: data.template,
      customerName: data.customerName,
      contextText: data.contextText,
      requirement1: data.requirement1,
      requirement2: data.requirement2,
      systemPrompt: data.systemPrompt,
    });
    return { rephrased: finalSms };
  });

export const autoRephraseLeadWithAi = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ leadId: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { success: false, reason: "Missing OPENAI_API_KEY" };

    // Check if auto-rephrase toggle is enabled (default is OFF)
    const { data: toggleState } = await supabaseAdmin
      .from("shared_state")
      .select("value")
      .eq("key", "cs_auto_rephrase_enabled")
      .maybeSingle();

    const isAutoRephraseOn = Boolean(
      toggleState?.value &&
      typeof toggleState.value === "object" &&
      !Array.isArray(toggleState.value) &&
      (toggleState.value as { enabled?: boolean }).enabled
    );

    if (!isAutoRephraseOn) {
      return { success: false, reason: "Auto-rephrase is disabled (toggle is OFF)" };
    }

    const { data: lead, error } = await supabaseAdmin
      .from("qualified_leads")
      .select("id, customer_name, context, post_text, requirement_1, requirement_2, marketing_notes")
      .eq("id", data.leadId)
      .maybeSingle();

    if (error || !lead) return { success: false, reason: "Lead not found" };

    // Strict safety check: If marketing_notes is already populated, DO NOT overwrite!
    if (lead.marketing_notes && lead.marketing_notes.trim().length > 0) {
      return { success: false, reason: "Already has marketing_notes" };
    }

    const contextText = lead.context || lead.post_text || "";
    if (!contextText.trim()) {
      return { success: false, reason: "No context text available" };
    }

    try {
      const finalSms = await executeAiRephraseCore({
        template: DEFAULT_CS_COMPOSE_TEMPLATE,
        customerName: lead.customer_name || "there",
        contextText,
        requirement1: lead.requirement_1 || "",
        requirement2: lead.requirement_2 || "",
      });

      if (finalSms) {
        // Update database with rephrased SMS
        await supabaseAdmin
          .from("qualified_leads")
          .update({ marketing_notes: finalSms } as never)
          .eq("id", lead.id);

        return { success: true, rephrased: finalSms };
      }
    } catch (err) {
      console.error("[Auto-rephrase] Failed for lead:", lead.id, err);
      return { success: false, reason: (err as Error).message };
    }

    return { success: false, reason: "No output generated" };
  });
