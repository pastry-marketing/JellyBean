import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Timing-safe string comparison
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ─── MESSAGE EVENT CLASSIFICATION ─────────────────────────────────────────────
// ONLY these two event types create messages or touch unread state:
//   message:send     → customer/visitor sent a message
//   message:received → operator sent a message
//
// All other message:* events (message:notify:unread:send,
// message:acknowledge:*, etc.) are control/notification events
// and must NOT create crisp_messages rows or increment unread_count.
const GENUINE_MESSAGE_EVENTS = new Set(["message:send", "message:received"]);

function isGenuineMessageEvent(eventType: string): boolean {
  return GENUINE_MESSAGE_EVENTS.has(eventType);
}

/** Check if a message is a masked/redacted Crisp free-plan placeholder (e.g. 'xxxxx', 'xx xxxx xxxx') */
function isCrispMaskedMessage(content: string | null | undefined): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  const stripped = trimmed.replace(/[\s\p{P}\p{S}]/gu, "");
  return stripped.length >= 3 && /^x+$/i.test(stripped);
}
// ──────────────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(JSON.stringify({ error: "Server configuration missing" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rawBody = await req.text();
    const url = new URL(req.url);
    const providedKey = url.searchParams.get("key");

    if (!providedKey) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: Missing webhook secret key (?key=)" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    let body: Record<string, unknown>;

    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON payload" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const eventType = String(body.event || "unknown").toLowerCase();
    const data = body.data || body;
    const websiteId = body.website_id || data.website_id;

    if (!websiteId) {
      return new Response(JSON.stringify({ message: "No website_id in payload, event ignored" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1. LOOKUP WORKSPACE — must be active and enabled
    const { data: wsRecord, error: wsErr } = await supabase
      .from("crisp_workspaces")
      .select("id, enabled, credential_secret_id")
      .eq("crisp_website_id", websiteId)
      .maybeSingle();

    if (wsErr || !wsRecord?.enabled || !wsRecord.credential_secret_id) {
      return new Response(
        JSON.stringify({
          error: "Unauthorized: workspace is missing, disabled, or not configured.",
        }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: secretData, error: secretErr } = await supabase.rpc(
      "crisp_get_workspace_secret",
      {
        p_secret_id: wsRecord.credential_secret_id,
      },
    );

    const storedWebhookSecret =
      (secretData as Record<string, unknown>)?.webhook_secret ||
      (secretData as Record<string, unknown>)?.webhookSecret;

    if (
      secretErr ||
      !storedWebhookSecret ||
      !timingSafeEqual(providedKey, storedWebhookSecret as string)
    ) {
      return new Response(JSON.stringify({ error: "Unauthorized: webhook key mismatch." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update last_seen_at (best effort, do not fail on error)
    await supabase
      .from("crisp_workspaces")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", wsRecord.id);

    const sessionId = data.session_id || body.session_id;

    if (!sessionId) {
      return new Response(
        JSON.stringify({ status: "success", message: "Event processed (no session_id)" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ─── EVENT CLASSIFICATION ───────────────────────────────────────────────
    const isMessageEvent = isGenuineMessageEvent(eventType);
    const rawFrom = String(data.from || "user").toLowerCase();
    const isOperator = rawFrom === "operator";
    // Customer messages are: genuine message:send events from non-operator sender
    const isCustomerMessage = eventType === "message:send" && !isOperator;

    // Fingerprint uniquely identifies this delivery event (safeguarded against collision)
    const uniqueQualifier = isMessageEvent
      ? `msg_${data.fingerprint || data.timestamp || Date.now()}`
      : `session_${eventType}_${data.timestamp || Date.now()}`;
    const eventFingerprint = `${websiteId}_${eventType}_${sessionId}_${uniqueQualifier}`;

    // 2. LOG WEBHOOK EVENT with processed: false initially
    const { data: eventRow, error: webhookLogErr } = await supabase
      .from("crisp_webhook_events")
      .insert({
        crisp_website_id: websiteId,
        event_fingerprint: eventFingerprint,
        event_type: eventType,
        payload: body,
        processed: false,
      })
      .select("id, processed")
      .maybeSingle();

    let webhookEventId: string | null = null;

    if (webhookLogErr && webhookLogErr.code === "23505") {
      // Duplicate fingerprint — check existing record state
      const { data: existingEvt, error: existingErr } = await supabase
        .from("crisp_webhook_events")
        .select("id, processed")
        .eq("event_fingerprint", eventFingerprint)
        .maybeSingle();

      if (existingErr) {
        console.error("Failed to look up duplicate webhook event:", existingErr.message);
        return new Response(JSON.stringify({ error: "Failed to look up duplicate event" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (existingEvt?.processed === true) {
        // Already fully processed — safe to acknowledge and return
        return new Response(
          JSON.stringify({
            status: "ignored",
            message: "Duplicate webhook event already processed",
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // processed = false → retry allowed — reuse the existing event row ID
      // This is critical: we MUST reuse the existing ID so we update the
      // correct row, and we must never increment unread_count twice.
      webhookEventId = existingEvt?.id ?? null;
    } else if (!webhookLogErr && eventRow) {
      webhookEventId = eventRow.id;
    }

    // Handle content for any message type
    let messageContent = "";
    if (isMessageEvent) {
      const rawContent = data.content;
      if (typeof rawContent === "string" && rawContent.trim()) {
        messageContent = rawContent.trim();
      } else if (rawContent && typeof rawContent === "object") {
        if (typeof rawContent.text === "string" && rawContent.text.trim()) {
          messageContent = rawContent.text.trim();
        } else if (typeof rawContent.name === "string" && rawContent.name.trim()) {
          messageContent = rawContent.name.trim();
        }
      }
      if (!messageContent) {
        if (data.type === "file" || data.type === "attachment") {
          messageContent = "[File]";
        } else if (
          data.type === "animation" ||
          data.type === "picker" ||
          data.type === "image" ||
          data.type === "media"
        ) {
          messageContent = "[Image]";
        } else if (data.type === "audio") {
          messageContent = "[Audio]";
        } else {
          messageContent = "[Attachment]";
        }
      }
    }

    try {
      // 3. Upsert conversation (customer details + unread state)
      const { data: existingConv } = await supabase
        .from("crisp_conversations")
        .select(
          "id, customer_name, customer_email, customer_phone, customer_avatar, last_message, last_message_at, last_customer_unread_at, status, unread_count",
        )
        .eq("crisp_website_id", websiteId)
        .eq("crisp_session_id", sessionId)
        .maybeSingle();

      const customerUser = data.user || body.user || {};
      const incomingName =
        customerUser.nickname || customerUser.name || data.nickname || body.nickname || null;
      const incomingEmail = customerUser.email || data.email || body.email || null;
      const incomingPhone = customerUser.phone || data.phone || body.phone || null;
      const incomingAvatar = customerUser.avatar || data.avatar || body.avatar || null;
      const incomingState = data.state || body.state || null;

      const finalName = incomingName || existingConv?.customer_name || null;
      const finalEmail = incomingEmail || existingConv?.customer_email || null;
      const finalPhone = incomingPhone || existingConv?.customer_phone || null;
      const finalAvatar = incomingAvatar || existingConv?.customer_avatar || null;
      const finalState = incomingState || existingConv?.status || "unresolved";

      const sentAt = data.timestamp
        ? new Date(data.timestamp).toISOString()
        : new Date().toISOString();

      // ── IDEMPOTENT UNREAD COUNT ────────────────────────────────────────────
      // Check if a crisp_messages row for this message already exists BEFORE
      // computing the new unread count. If the message already exists (retry),
      // do NOT increment unread_count again.
      const crispMsgId = isMessageEvent
        ? String(data.fingerprint || `${sessionId}_${sentAt}`)
        : null;

      let messageAlreadyExists = false;
      if (isMessageEvent && crispMsgId) {
        const { data: existingMsg } = await supabase
          .from("crisp_messages")
          .select("id")
          .eq("crisp_message_id", crispMsgId)
          .maybeSingle();
        messageAlreadyExists = !!existingMsg;
      }

      const currentUnread = Number(existingConv?.unread_count || 0);
      let updatedUnread = currentUnread;
      const isMaskedMsg = isCrispMaskedMessage(messageContent);

      if (isCustomerMessage && !messageAlreadyExists && !isMaskedMsg) {
        updatedUnread = currentUnread + 1;
      } else if (isOperator || isMaskedMsg) {
        // Operator reply or masked message clears/prevents awaiting-reply state
        updatedUnread = 0;
      }

      const lastMessage =
        isMessageEvent && messageContent ? messageContent : existingConv?.last_message || null;
      const lastMessageAt =
        isMessageEvent && messageContent ? sentAt : existingConv?.last_message_at || sentAt;

      // Set last_customer_unread_at ONLY on genuine NEW incoming customer messages
      // Operator messages or masked messages clear it
      const lastCustomerUnreadAt =
        isCustomerMessage && !messageAlreadyExists && !isMaskedMsg
          ? sentAt
          : updatedUnread > 0
            ? existingConv?.last_customer_unread_at || null
            : null;

      const { data: convData, error: convErr } = await supabase
        .from("crisp_conversations")
        .upsert(
          {
            crisp_website_id: websiteId,
            crisp_session_id: sessionId,
            customer_name: finalName,
            customer_email: finalEmail,
            customer_phone: finalPhone,
            customer_avatar: finalAvatar,
            status: finalState,
            last_message: lastMessage,
            last_message_at: lastMessageAt,
            last_customer_unread_at: lastCustomerUnreadAt,
            unread_count: updatedUnread,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "crisp_website_id,crisp_session_id" },
        )
        .select("id")
        .single();

      if (convErr) {
        throw new Error(`Error upserting crisp_conversations: ${convErr.message}`);
      }

      const conversationId = convData.id;

      // 4. Insert message into crisp_messages (idempotent via ON CONFLICT DO NOTHING)
      if (isMessageEvent && messageContent && crispMsgId && !messageAlreadyExists) {
        const senderType = isOperator ? "operator" : "customer";
        const direction = isOperator ? "outgoing" : "incoming";

        const { error: msgErr } = await supabase.from("crisp_messages").insert({
          conversation_id: conversationId,
          crisp_website_id: websiteId,
          crisp_session_id: sessionId,
          crisp_message_id: crispMsgId,
          sender_type: senderType,
          direction: direction,
          content: messageContent,
          message_type: data.type || "text",
          sent_at: sentAt,
          raw_payload: data,
        });

        // 23505 = unique_violation (message already inserted by a concurrent request) — safe to ignore
        if (msgErr && msgErr.code !== "23505") {
          throw new Error(`Error inserting crisp_messages: ${msgErr.message}`);
        }
      }

      // 5. Mark webhook event as processed: true
      if (webhookEventId) {
        const { error: markDoneErr } = await supabase
          .from("crisp_webhook_events")
          .update({ processed: true, error: null })
          .eq("id", webhookEventId);

        if (markDoneErr) {
          console.error("Failed to mark webhook event processed:", markDoneErr.message);
        }
      }

      return new Response(
        JSON.stringify({ status: "success", session_id: sessionId, website_id: websiteId }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (processErr: unknown) {
      console.error("Webhook processing error:", processErr);
      const processErrorMsg =
        processErr instanceof Error ? processErr.message : "Webhook processing failed";

      // Leave processed: false and record error in the correct `error` column
      if (webhookEventId) {
        const { error: errUpdateErr } = await supabase
          .from("crisp_webhook_events")
          .update({ processed: false, error: processErrorMsg })
          .eq("id", webhookEventId);

        if (errUpdateErr) {
          console.error("Failed to record webhook error:", errUpdateErr.message);
        }
      }

      return new Response(JSON.stringify({ error: processErrorMsg }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } catch (err: unknown) {
    console.error("Crisp webhook error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
