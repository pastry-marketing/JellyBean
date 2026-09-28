// Server-only Crisp helpers. These run inside the app server runtime and talk
// to the Crisp REST API directly using per-workspace credentials stored in Vault.

type QueryBuilder = {
  select: (cols: string) => QueryBuilder;
  eq: (col: string, val: unknown) => QueryBuilder;
  maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: Error | null }>;
  single: () => Promise<{ data: { id: string } | null; error: Error | null }>;
  update: (data: unknown) => QueryBuilder;
  upsert: (
    data: unknown,
    opts?: unknown,
  ) => QueryBuilder & Promise<{ data: { id: string }[] | null; error: Error | null }>;
};

type AnyClient = {
  from: (t: string) => QueryBuilder;
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: Record<string, unknown> | null; error: Error | null }>;
};

export type CrispCreds = { tokenId: string; tokenKey: string };

export function crispHeaders(creds: CrispCreds) {
  const auth = btoa(`${creds.tokenId}:${creds.tokenKey}`);
  return {
    Authorization: `Basic ${auth}`,
    "X-Crisp-Tier": "website",
    "Content-Type": "application/json",
  };
}

export async function crispErrorReason(res: Response) {
  const json = (await res.json().catch(() => ({}))) as {
    reason?: string;
    message?: string;
    data?: { message?: string };
  } & Record<string, unknown>;
  return json?.reason || json?.data?.message || json?.message || `HTTP ${res.status}`;
}

/** Read a workspace's Crisp credentials out of Vault. */
export async function getWorkspaceCreds(
  admin: AnyClient,
  secretId: string,
): Promise<{ ok: true; creds: CrispCreds } | { ok: false; error: string }> {
  const { data, error } = await admin.rpc("crisp_get_workspace_secret", { p_secret_id: secretId });
  const tokenId = data?.token_id ?? data?.tokenId;
  const tokenKey = data?.token_key ?? data?.tokenKey;
  if (error || !tokenId || !tokenKey) {
    return {
      ok: false,
      error: `Workspace credentials unavailable: ${error?.message ?? "missing token"}`,
    };
  }
  return { ok: true, creds: { tokenId: String(tokenId), tokenKey: String(tokenKey) } };
}

/** Crisp free-plan masked placeholder message, e.g. "xxx xxxx". */
export function isCrispMaskedMessage(content: string | null | undefined): boolean {
  if (!content) return false;
  const stripped = content.trim().replace(/[\s\p{P}\p{S}]/gu, "");
  return stripped.length >= 3 && /^x+$/i.test(stripped);
}

export function parseMessageContent(msg: Record<string, unknown>): string {
  const raw = msg?.content;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (raw && typeof raw === "object") {
    if (typeof raw.text === "string" && raw.text.trim()) return raw.text.trim();
    if (typeof raw.name === "string" && raw.name.trim()) return raw.name.trim();
  }
  const type = msg?.type;
  if (type === "file" || type === "attachment") return "[File]";
  if (type === "animation" || type === "picker" || type === "image" || type === "media")
    return "[Image]";
  if (type === "audio") return "[Audio]";
  return "[Attachment]";
}

/** Sync one Crisp workspace's recent conversations + messages into Supabase. */
export async function syncWorkspace(
  admin: AnyClient,
  ws: {
    id: string;
    crisp_website_id: string;
    workspace_name: string | null;
    credential_secret_id: string | null;
  },
  opts: { maxPages: number },
): Promise<{ conversations: number; messages: number; error?: string }> {
  const websiteId = ws.crisp_website_id;
  if (!ws.credential_secret_id)
    return { conversations: 0, messages: 0, error: "No stored credentials for workspace" };

  const credsRes = await getWorkspaceCreds(admin, ws.credential_secret_id);
  if (!credsRes.ok) return { conversations: 0, messages: 0, error: credsRes.error };
  const headers = crispHeaders(credsRes.creds);

  let conversations = 0;
  let messages = 0;

  if (!ws.workspace_name) {
    try {
      const infoRes = await fetch(`https://api.crisp.chat/v1/website/${websiteId}`, { headers });
      if (infoRes.ok) {
        const info = (await infoRes.json()) as { data?: { name?: string } } & Record<
          string,
          unknown
        >;
        const name = info?.data?.name;
        if (name)
          await admin.from("crisp_workspaces").update({ workspace_name: name }).eq("id", ws.id);
      }
    } catch {
      // Non-fatal
    }
  }

  for (let page = 1; page <= opts.maxPages; page++) {
    const listRes = await fetch(
      `https://api.crisp.chat/v1/website/${websiteId}/conversations/${page}`,
      { headers },
    );
    if (!listRes.ok) {
      return { conversations, messages, error: await crispErrorReason(listRes) };
    }
    const listJson = (await listRes.json()) as { data?: Record<string, unknown>[] } & Record<
      string,
      unknown
    >;
    const sessions = (Array.isArray(listJson?.data) ? listJson.data : []) as Array<
      {
        session_id?: string;
        meta?: Record<string, unknown>;
        nickname?: string;
        email?: string;
        phone?: string;
        avatar?: string;
        state?: string;
      } & Record<string, unknown>
    >;
    if (sessions.length === 0) break;

    const CHUNK = 5;
    for (let i = 0; i < sessions.length; i += CHUNK) {
      await Promise.allSettled(
        sessions.slice(i, i + CHUNK).map(async (session) => {
          const sessionId = session?.session_id;
          if (!sessionId) return;
          const meta = session.meta || {};

          const { data: existing } = await admin
            .from("crisp_conversations")
            .select("customer_name, customer_email, customer_phone, customer_avatar")
            .eq("crisp_website_id", websiteId)
            .eq("crisp_session_id", sessionId)
            .maybeSingle();

          const { data: conv, error: convErr } = await admin
            .from("crisp_conversations")
            .upsert(
              {
                crisp_website_id: websiteId,
                crisp_session_id: sessionId,
                customer_name: meta.nickname || session.nickname || existing?.customer_name || null,
                customer_email: meta.email || session.email || existing?.customer_email || null,
                customer_phone: meta.phone || session.phone || existing?.customer_phone || null,
                customer_avatar: meta.avatar || session.avatar || existing?.customer_avatar || null,
                status: session.state || "unresolved",
                updated_at: new Date().toISOString(),
              },
              { onConflict: "crisp_website_id,crisp_session_id" },
            )
            .select("id")
            .single();

          if (convErr || !conv) return;
          conversations++;

          const msgsRes = await fetch(
            `https://api.crisp.chat/v1/website/${websiteId}/conversation/${sessionId}/messages`,
            { headers },
          );
          if (!msgsRes.ok) return;
          const msgsJson = (await msgsRes.json()) as { data?: Record<string, unknown>[] } & Record<
            string,
            unknown
          >;
          const list = (Array.isArray(msgsJson?.data) ? msgsJson.data : []) as Array<
            { from?: string; timestamp?: number; type?: string; fingerprint?: string } & Record<
              string,
              unknown
            >
          >;

          if (list.length === 0) {
            await admin
              .from("crisp_conversations")
              .update({
                unread_count: 0,
                last_customer_unread_at: null,
                updated_at: new Date().toISOString(),
              })
              .eq("id", conv.id);
            return;
          }

          list.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

          let lastCustomerAt: string | null = null;
          let lastCustomerText: string | null = null;
          let lastCustomerTs = 0;
          let lastOperatorTs = 0;
          for (let k = list.length - 1; k >= 0; k--) {
            const m = list[k];
            const from = String(m.from || "user").toLowerCase();
            const ts = m.timestamp || 0;
            if (from !== "operator" && !lastCustomerAt) {
              lastCustomerAt = m.timestamp ? new Date(m.timestamp).toISOString() : null;
              lastCustomerText = parseMessageContent(m);
              lastCustomerTs = ts;
            } else if (from === "operator" && !lastOperatorTs) {
              lastOperatorTs = ts;
            }
          }

          const needsReply = Boolean(
            lastCustomerAt &&
            !isCrispMaskedMessage(lastCustomerText) &&
            (!lastOperatorTs || lastCustomerTs > lastOperatorTs),
          );

          const rows = list.map((msg) => {
            const isOperator = String(msg.from).toLowerCase() === "operator";
            return {
              conversation_id: conv.id,
              crisp_website_id: websiteId,
              crisp_session_id: sessionId,
              crisp_message_id: String(msg.fingerprint || `${sessionId}_${msg.timestamp}`),
              sender_type: isOperator ? "operator" : "customer",
              direction: isOperator ? "outgoing" : "incoming",
              content: parseMessageContent(msg),
              message_type: msg.type || "text",
              sent_at: msg.timestamp
                ? new Date(msg.timestamp).toISOString()
                : new Date().toISOString(),
              raw_payload: msg,
            };
          });

          // Bulk insert; duplicates are ignored by the existing table trigger/constraint.
          const { error: insErr, data: inserted } = await admin
            .from("crisp_messages")
            .upsert(rows, {
              onConflict: "crisp_website_id,crisp_message_id",
              ignoreDuplicates: true,
            })
            .select("id");
          if (!insErr) messages += inserted?.length ?? 0;

          const newest = list[list.length - 1];
          await admin
            .from("crisp_conversations")
            .update({
              last_message: parseMessageContent(newest),
              last_message_at: newest.timestamp
                ? new Date(newest.timestamp).toISOString()
                : new Date().toISOString(),
              unread_count: needsReply ? 1 : 0,
              last_customer_unread_at: needsReply ? lastCustomerAt : null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", conv.id);
        }),
      );
    }
  }

  await admin
    .from("crisp_workspaces")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("id", ws.id);

  return { conversations, messages };
}
