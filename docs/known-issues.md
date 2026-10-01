# Known issues

Open defects and documentation inconsistencies, recorded 2026-10-01 against
`main` @ `a85f68a`. Severity reflects production risk, not effort.

---

## P1 — CI lint gate still failing on `main`

`.github/workflows/ci.yml` gates every push and PR on two commands. The
TypeScript step is now clean; the ESLint step is not.

| Check                            | Result                                      |
| -------------------------------- | ------------------------------------------- |
| `bunx tsc --noEmit`              | ✅ **0 errors** (was 34 — fixed 2026-10-01) |
| `bunx eslint . --max-warnings 0` | ❌ **35 warnings** (zero-tolerance flag)    |
| `bun run test:run`               | ✅ 46 / 46                                  |

The 34 TypeScript errors have been fixed. See [Resolved below](#resolved--34-typescript-errors)
for what they were and how they were addressed.

### 1.1 — 35 ESLint warnings

Two rules account for all of them.

**`react-hooks/exhaustive-deps` (21)** — the majority. Mostly `useMemo`
dependencies built from logical expressions that are re-created on every render,
so the memo never actually memoises:

| File                                                 | Pattern                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/routes/app.reports.tsx:690,701,748`             | `rawUsers` logical expression                                                               |
| `src/routes/app.reports.tsx:1355`                    | `allProfiles` logical expression                                                            |
| `src/routes/app.reports.tsx:802,828`                 | `deptRows` logical expression                                                               |
| `src/routes/app.reports.tsx:256,267,271,273,279,289` | `series` / `csBuckets` / `prevSeries`                                                       |
| `src/routes/app.reports.tsx:1269,1279`               | `rawRows` logical expression                                                                |
| `src/routes/app.raw-leads.tsx:1168`                  | missing `qc`                                                                                |
| `src/routes/app.submit-lead.tsx:233`                 | missing `isFacebook`                                                                        |
| `src/routes/app.crisp-chat.tsx` (6)                  | missing `loadConversations` / `loadMessages` / `selectedConversation` / `selectedWebsiteId` |

**`react-refresh/only-export-components` (14)** — `app.reports.tsx:103,126` and
others export non-component values from component files.

> **Why this is not fixed here.** `exhaustive-deps` is not cosmetic: adding a
> dependency that is itself re-created each render converts a memo into a
> recompute, and for the `useEffect` cases can cause an **infinite render
> loop**. Fixing these correctly means wrapping the offending expressions in
> their own `useMemo` or converting handlers to `useCallback`, per site, with
> manual verification in the browser. It should be done as a focused change with
> the affected pages open — not folded into a type-fix commit.
>
> `react-refresh/only-export-components` is the opposite: purely mechanical, but
> it means moving shared constants into sibling modules.
>
> Both are safe to do together as a single dedicated PR.

---

## Resolved — 34 TypeScript errors

Fixed 2026-10-01. `bunx tsc --noEmit` now reports **0 errors**; `bun run lint`
reports **0 errors / 35 warnings**; tests remain **46 / 46**.

The 34 errors reduced to four root causes. Kept here because the same patterns
will recur as the Crisp integration grows.

**(a) `TS2589` — excessively deep type instantiation**

The generated `Database` type in `src/integrations/supabase/types.ts` is ~1,718
lines covering 24 tables, 3 views, ~40 functions and 3 enums. When
`SupabaseClient<Database>` was passed into helpers that declared their own
hand-rolled structural client type, TypeScript had to instantiate the entire
generated schema to check the match and exhausted its budget.

This one error caused most of the other 33 — the `TS2345` argument errors
elsewhere in `crisp.functions.ts` were the same generic collapsing one level up.

_Fix applied:_ `assertCrispAccess` and `assertAdmin` now accept the client as
`unknown` and narrow once through a shared `fetchCallerRoles` helper, so
accepting a client costs no structural comparison. A deliberately shallow
`RoleQueryClient` type with `unknown` leaves documents the one query performed.
No `any` was introduced.

**(b) `TS2339` — untyped Crisp JSON payloads** _(the highest-value fix)_

Crisp returns attachment payloads as untyped JSON. Because
`MessageRecord.raw_payload` was `Record<string, unknown>`, a
`typeof x === "object"` guard narrowed to bare `object`, so reading `.url`,
`.size`, or `.duration` failed to compile. A mistyped attachment field
silently drops a customer's photo, so these were the errors most worth fixing
properly rather than casting away.

_Fix applied:_ introduced explicit `CrispAttachmentContent` and `CrispRawPayload`
shapes, narrowed once into a local `attachmentContent`, and reused that
reference for the later `duration` read. `crisp.server.ts`'s
`parseMessageContent` now narrows `raw` to `Record<string, unknown>` before
reading `.text` / `.name`.

**(c) `TS2339` — wrong result shape on a query builder** — `crisp.server.ts:255`

`.data` / `.error` were destructured from a builder whose type did not model
PostgREST's dual nature.

_Fix applied:_ `QueryBuilder` is now an `interface` extending `PromiseLike<…>`,
so it is both chainable (`.select().eq().eq().maybeSingle()`) and awaitable
(`await …upsert(rows).select("id")`). `update` correctly returns `QueryBuilder`.

**(d) `TS2322` — object-literal shape mismatches**

- `crisp.functions.ts` — the Crisp API response was cast to
  `{ … } & Record<string, unknown>`, which is not assignable to the `Json`
  column type. Now cast to `Json`, which is what `res.json()` actually returns.
- `crisp-message-notifier.tsx` — `conversation_id` was `string | undefined` but
  is used both to fetch the conversation and to build the alert. Added a real
  guard (`if (!newMsg?.id || !newMsg.conversation_id) return;`) rather than a
  cast, since an alert without a conversation cannot be actioned.
- `nextdoor-leads-webhook.ts` — the row types declared
  `data?: Record<string, string> | null` while the column is JSONB. `data` was
  never read from those rows, so the unused field was dropped from the type
  instead of being cast.

---

### Note on dead code

`noUnusedLocals` and `noUnusedParameters` are both `false` in `tsconfig.json`,
and `@typescript-eslint/no-unused-vars` is `"off"` in the ESLint config, so dead
code is not currently flagged anywhere. Worth enabling deliberately at some
point — expect a non-trivial first pass.

---

## P2 — Trust page contradicts platform configuration

`src/routes/trust.tsx:35` states there is "no public sign-up". The Supabase
project reports `disable_signup: false`, so the auth API **does** accept
self-registration.

Mitigations already in place: the app ships no sign-up form; `/app` renders a
"No role assigned" screen for role-less accounts; email confirmation is required
(`mailer_autoconfirm: false`).

Because `/trust` is a compliance-facing document, it should not assert something
the platform contradicts. Either disable sign-up in Supabase Auth settings or
reword the claim to describe what the _application_ enforces rather than what
the _platform_ permits.

Full method and evidence: [`backend-verification.md`](backend-verification.md) §5.

---

## P3 — Misleading migration filename

`supabase/migrations/20260707130000_make_lead_attachments_bucket_public.sql`
implies the `lead-attachments` bucket is public. **Live behaviour contradicts
it** — the bucket is not readable without credentials, and `/trust`'s "private
bucket" claim is the accurate one. Verified by comparing against a control
bucket name; see [`backend-verification.md`](backend-verification.md) §4.

Either confirm the migration was never applied to production, or document the
effective state so a future reader does not "fix" the bucket to public by
mistake.

---

## P4 — Credential hygiene

**Long-lived anon JWT committed to source.** `src/integrations/supabase/client.ts:27`
falls back to a 208-character `anon` JWT valid until ≈ 2036. It is an `anon` key
so RLS still applies and this is not a direct breach, but it means every fork
inherits a credential, and rotation requires a code change. Prefer requiring
`VITE_SUPABASE_PUBLISHABLE_KEY` and failing loudly when it is absent.

**`sbp_…` publishable key rejected.** The publishable key supplied during the
2026-10-01 audit returned `UNAUTHORIZED_INVALID_API_KEY` from the gateway —
stale or rotated. The legacy JWT is what currently works. Confirm which key is
authoritative; see [`backend-verification.md`](backend-verification.md).

---

## P5 — Tests do not run in CI

`.github/workflows/ci.yml` runs `tsc` and `eslint` but **not** `vitest run`, and
there is no coverage reporting. The 46 existing tests would not catch a
regression on their own. Adding `bun run test:run` to the workflow is a
one-line change with clear value.

Test coverage is unit-only — no component, integration, or E2E layer exists.

---

## P6 — Documentation drift already addressed

The previous `README.md` was materially wrong. Corrected in the 2026-10-01
documentation pass:

| Was                                    | Reality                                            |
| -------------------------------------- | -------------------------------------------------- |
| Role `processor`                       | Renamed to `maturing` (migration `20260619183000`) |
| `cs_admin` missing entirely            | One of nine roles                                  |
| AI model `gpt-5-nano`                  | `gpt-5.4-nano-2026-03-17`                          |
| No mention of Crisp                    | 4 edge functions, 5 tables, 11 server functions    |
| No mention of the access-code gate     | Required second factor for all non-admins          |
| No mention of Vault-backed credentials | Central to the Crisp design                        |

Also stale or misleading:

- **`.lovable/plan.md`** — an 8-stage performance plan that was never started.
  None of `src/lib/queries/`, `src/components/skeletons/`,
  `@tanstack/react-virtual`, or URL-driven pagination exists. It ends with
  "Confirm and I'll start with stage 1". Treat as a proposal, not a description
  of the system.
- **`docs/cs-pipeline-two-best-questions-plan.md`** — untracked. A
  20-section specification for conversational lead qualification that is
  **not implemented**. It references `OPENAI_COMPOSER_MODEL` and treats the
  `gpt-5.4-nano-2026-03-17` model as configurable; neither is true today. It is
  a forward-looking proposal, not a description of current behaviour.
- **`OPENAI_MODEL`** in `.env.example` — no code reads it. Model IDs are pinned
  in `raw-leads-ai.functions.ts`.
- **`VITE_SUPABASE_PROJECT_ID`** — declared, never read.
- **`VITE_GOOGLE_SHEETS_WEBHOOK_URL`** — read by `google-sheets-sync.ts:28` but
  was absent from `.env.example`. Now documented.

---

## P7 — Dead and orphaned code

Candidates for removal, none urgent:

- `emergency-dashboard.html` and `generate_emergency_tool.py` — a standalone
  recovery page loading Supabase from a CDN. Not part of the build, referenced by
  no route.
- `google-sheets-sync-code.js` (v2.6) — the Apps Script source, useful as an
  operational reference but sits at repo root rather than in `docs/`.
- Declared but unreferenced dependencies: `qrcode`, `@fontsource/epilogue`,
  `@fontsource/urbanist`, `@cloudflare/vite-plugin`, `@hookform/resolvers`,
  `@tanstack/router-plugin`.
- `.output/` and `.wrangler/` build residue is gitignored but present locally.

---

## P8 — Unverified against production

From the read-only audit: the **~40 RPCs** in `types.ts` could not be confirmed
present in the live database without executing them, and several have side
effects. Any runtime dependency on a specific RPC signature should be verified
from an authenticated session.

The two materialized views (`mv_qualified_leads_status_counts`,
`mv_raw_lead_cache_counts`) correctly deny `anon`; the app reaches them via
service role, so this is expected.

---

## Suggested order of work

1. **1.1(a)** — fix the `TS2589` generic collapse; it likely clears ~8 errors
2. **1.1(b)** — type the Crisp payloads; highest real-world risk
3. **1.1(c, d)** — small, mechanical
4. **1.2** — exhaustive-deps and fast-refresh warnings
5. **P5** — add `vitest run` to CI
6. **P2 / P3 / P4** — trust page wording, migration naming, credential rotation
