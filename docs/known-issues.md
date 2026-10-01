# Known issues

Open defects and documentation inconsistencies, recorded 2026-10-01 against
`main` @ `a85f68a`. Severity reflects production risk, not effort.

---

## P1 — CI is failing on `main`

`.github/workflows/ci.yml` gates every push and PR on two commands that
currently fail. This means the repository's own quality signal is broken and
new work cannot be merged cleanly.

| Check                            | Result                                   |
| -------------------------------- | ---------------------------------------- |
| `bunx tsc --noEmit`              | ❌ **34 errors**                         |
| `bunx eslint . --max-warnings 0` | ❌ **35 warnings** (zero-tolerance flag) |
| `bun run test:run`               | ✅ 46 / 46                               |

### 1.1 — 34 TypeScript errors, concentrated in Crisp + webhook

| File                                        | Errors |
| ------------------------------------------- | -----: |
| `src/routes/app.crisp-chat.tsx`             |     12 |
| `src/lib/crisp.functions.ts`                |     10 |
| `src/lib/crisp.server.ts`                   |      8 |
| `src/components/crisp-message-notifier.tsx` |      2 |
| `src/lib/nextdoor-leads-webhook.ts`         |      2 |

They reduce to **four** root causes.

**(a) `TS2589` — excessively deep type instantiation** — `src/lib/crisp.functions.ts:39`

```
Type instantiation is excessively deep and possibly infinite.
```

The generated `Database` type in `src/integrations/supabase/types.ts` is ~1,718
lines covering 24 tables, 3 views, ~40 functions and 3 enums. When
`SupabaseClient<Database>` is threaded through a generic helper, TypeScript
exhausts its instantiation budget.

This single error **causes most of the other 33**: the `TS2345` argument errors
at `crisp.functions.ts:97,187,324,436,457,500,560` are all
`SupabaseClient<Database, "public", "public", …>` failing to match a parameter
type, which is the same generic collapsing one level up.

_Suggested fix:_ narrow the client type at the module boundary — declare a local
row-type alias for the Crisp tables and type the client against that subset
rather than the full `Database`. Widening to `SupabaseClient<any>` in that one
module is a pragmatic stopgap, but prefer the narrow subset so the rest of the
app keeps inference.

**(b) `TS2339` — untyped Crisp JSON payloads**

```
src/lib/crisp.server.ts:72    Property 'text' does not exist on type 'object'
src/lib/crisp.server.ts:73    Property 'name' does not exist on type 'object'
src/routes/app.crisp-chat.tsx:159-162  '.url' '.preview' '.name' '.filename' '.type' '.size'
src/routes/app.crisp-chat.tsx:184     Property 'toLowerCase' does not exist on type '{}'
src/routes/app.crisp-chat.tsx:205-206 Property 'duration' does not exist on type '{}'
```

Crisp's API returns attachment and rich-content payloads that are typed as bare
`object` / `{}`. The code reads fields off them directly. This is the **highest
-value fix in the list** because these are live chat paths — a mistyped
attachment field silently drops a customer's photo.

_Suggested fix:_ declare explicit interfaces (`CrispAttachment`,
`CrispContentPart`) and add narrowing guards before field access. Note that
`parseMessageContent` in `crisp.server.ts` already parses `[File]` / `[Image]` /
`[Audio]` / `[Attachment]` fallbacks — that parsing should be the single source
of truth rather than each call site re-reading raw fields.

**(c) `TS2339` — wrong result shape on a query builder** — `src/lib/crisp.server.ts:255`

```
Property 'error' does not exist on type 'QueryBuilder'
Property 'data' does not exist on type 'QueryBuilder'
```

A `QueryBuilder` is being destructured for `.data` / `.error` before it is
awaited. Without `await` (or a missing `.single()` / `.maybeSingle()`), the
builder has no result fields.

_Suggested fix:_ `await` the builder, or apply the terminal method that narrows
the type.

**(d) `TS2322` — object-literal shape mismatches**

```
src/lib/crisp.functions.ts:172
src/components/crisp-message-notifier.tsx:283
src/lib/nextdoor-leads-webhook.ts:394,403   { id, canonical_post_id, … }
```

Row inserts and typed payloads drifted from their target types. Low risk, small
fix — reconcile the literal with the column set.

### 1.2 — 35 ESLint warnings under `--max-warnings 0`

`bun run lint` reports 0 errors and 35 warnings, but CI escalates any warning to
a failure. Two rules dominate:

- **`react-hooks/exhaustive-deps`** — mostly `useMemo` dependencies built from
  logical expressions that re-create each render, e.g. `app.reports.tsx:687`
  (`rawUsers`) and `app.reports.tsx:1347` (`allProfiles`). Also
  `app.raw-leads.tsx:1168` (missing `qc`) and
  `app.submit-lead.tsx:233` (missing `isFacebook`).
- **`react-refresh/only-export-components`** — `app.reports.tsx:103,126` export
  non-component values from a component file.

Note that `noUnusedLocals` and `noUnusedParameters` are both `false` in
`tsconfig.json`, and `@typescript-eslint/no-unused-vars` is `"off"` in the ESLint
config, so dead code is not currently flagged anywhere.

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
