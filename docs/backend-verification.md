# Backend verification — production audit

**Date:** 2026-10-01
**Project ref:** `fjscqsatzsmfivpczaud`
**Scope:** read-only. No writes, no schema changes, no RPC execution.
**Purpose:** confirm that the deployed Supabase backend matches what the
application code and migrations assume, and surface any drift.

---

## Method

All checks used the **client-scoped `anon` key only**. No service-role key was
used, and no user session was created. Requests were limited to:

- `GET /rest/v1/<relation>?select=*&limit=1` with `Prefer: count=exact`
- `GET /auth/v1/settings`
- `GET /storage/v1/object/public/<bucket>/<path>`
- `OPTIONS /rest/v1/rpc/<name>`

Row counts were read from the `Content-Range` header with `limit=1`, so **no
customer data was retrieved** — the `anon` role is denied by RLS in every case
(see below), and even if it were not, counts expose no row contents.

RPC **execution** was deliberately avoided. Several RPCs
(`refresh_lead_counter_materialized_views`, `refresh_mv_qualified_leads_status_counts`)
have side effects, and `OPTIONS` does not distinguish an existing function from
a missing one. The RPC list in `src/integrations/supabase/types.ts` and
`supabase/migrations/` is therefore **unverified against production** and should
be confirmed from an authenticated session before relying on it.

### Credential note

The `sbp_…` publishable key supplied for this audit was rejected by the API
gateway with `UNAUTHORIZED_INVALID_API_KEY` on both `/auth/v1/user` and
`/rest/v1/`.
It appears to be stale or rotated.

The key that the application itself uses — the legacy 208-character `anon` JWT
present in `.env` and committed at `src/integrations/supabase/client.ts:27` — is
valid and was used instead. Worth confirming whether the newer publishable key
should replace it; the committed JWT is long-lived (`exp` ≈ 2036).

---

## Findings

### 1. Schema present and exposed — as expected

All **24 tables** referenced by the application resolve in the `public` schema
and are exposed through PostgREST. Verified by direct probe.

> **Scope limit:** this confirms the 24 relations the application actually uses,
> not that the database contains _only_ 24 tables. Enumerating every relation
> requires the PostgREST OpenAPI endpoint, which is restricted to `service_role`
> keys and was not available for this audit. The untracked
> `cs-pipeline-two-best-questions-plan.md` cites "25 tables, 1 view, 2
> materialized views" from its own earlier audit — that one-table difference is
> unresolved and would need a service-role or SQL-console check.

Three views:

| Relation                           | Result                        |
| ---------------------------------- | ----------------------------- |
| `processed_leads_export`           | `200` — present and reachable |
| `mv_qualified_leads_status_counts` | `401` — not granted to `anon` |
| `mv_raw_lead_cache_counts`         | `401` — not granted to `anon` |

The two materialized views returning `401` is **expected and benign**: the
application reaches them through server functions running as service role,
which bypasses grants. Anonymous access being denied is the desired outcome.

### 2. RLS is correctly denying anonymous access — verified across all tables

Every table was probed for exact row count as `anon`. All returned
`Content-Range: */0` — zero rows:

```
profiles                 */0      accounts                  */0
user_roles               */0      activity_logs             */0
user_access_codes        */0      app_settings              */0
qualified_leads          */0      shared_state              */0
raw_leads                */0      lead_drafts               */0
raw_lead_cache           */0      lead_reminders            */0
raw_lead_cache_counts    */0      map_snapshots             */0
service_assignments      */0      incogniton_profiles       */0
state_assignments        */0      crisp_workspaces          */0
                         */0      crisp_conversations       */0
                         */0      crisp_messages            */0
                         */0      crisp_webhook_events      */0
                         */0      crisp_conversation_notes  */0
                         */0      crm_update_notifications  */0
                         */0      crm_update_.._receipts    */0
```

This is the single most important result in this audit. Customer names, phone
numbers, and chat transcripts are **not** reachable without an authenticated
session carrying an appropriate role.

> Scope limit: this confirms the `anon` posture only. It does **not** prove that
> every _authenticated_ role is correctly restricted — in particular whether a
> freshly self-registered account with no assigned role can read anything. That
> requires an authenticated session and was out of scope here. See
> `known-issues.md`.

### 3. The `storage` schema is not exposed via PostgREST — good

`GET /rest/v1/buckets` returns `PGRST205 Could not find the table 'public.buckets'`.
Storage internals are reachable only through the dedicated Storage API. This is
correct hardening.

### 4. `lead-attachments` is effectively private — the trust page is right

Migration `20260707130000_make_lead_attachments_bucket_public.sql` suggests the
bucket was made public. **Live behaviour contradicts the filename.**

Test: compare `GET /storage/v1/object/public/<bucket>/<nonexistent>` for
`lead-attachments` against a control bucket name that certainly does not exist.
A public bucket answers `Object not found`; a private or hidden bucket answers
`Bucket not found`.

| Request                                                           | Response           |
| ----------------------------------------------------------------- | ------------------ |
| Control: `…/object/public/zzz-not-a-real-bucket-9999/probe.txt`   | `404 NoSuchBucket` |
| `…/object/public/lead-attachments/zzz-probe…txt` — no credentials | `404 NoSuchBucket` |
| `…/object/public/lead-attachments/zzz-probe…txt` — anon key       | `404 NoSuchBucket` |
| `GET /storage/v1/object/list/lead-attachments` — anon key         | `404 NoSuchBucket` |

`lead-attachments` is indistinguishable from a nonexistent bucket. It is **not
publicly readable**, and the `/trust` page's claim that attachments live in a
private bucket is **accurate in practice**.

This is consistent with the application code, which requests 1-hour signed URLs
(`src/lib/lead-attachments.tsx`) rather than public URLs.

**Conclusion:** the _effective_ state is correct; only the migration _filename_
is misleading. Recommend renaming the intent in documentation, or verifying
whether `20260707130000` was ever applied to production.

### 5. Public sign-up is enabled at the platform level — contradicts `/trust`

`GET /auth/v1/settings` reports:

```json
{ "disable_signup": false, "mailer_autoconfirm": false, ... }
```

`disable_signup: false` means the **auth API accepts self-registration** from
anyone who can reach it. The `/trust` page states:

> "The CRM is a private internal tool. Access requires an account created by an
> administrator — there is no public sign-up."

That claim is **factually incorrect at the platform level**. The app itself
exposes no sign-up form, and `/app` renders a "No role assigned" screen for
accounts without a role, so the practical impact is limited. Additional
mitigations: email confirmation is required (`mailer_autoconfirm: false`), so an
account registered with a bogus address cannot obtain a session.

Even so, the trust page is a compliance-facing document and should not assert
something the platform contradicts. Either disable sign-up in Supabase Auth
settings, or reword the page. Tracked in `known-issues.md`.

---

## Summary

| #   | Area                                         | Result                                 |
| --- | -------------------------------------------- | -------------------------------------- |
| 1   | Tables and views used by the app are present | ✅ Matches code                        |
| 2   | RLS denies `anon` on all 24 tables           | ✅ Verified, zero rows                 |
| 3   | `storage` schema not REST-exposed            | ✅ Hardened                            |
| 4   | `lead-attachments` not public                | ✅ Private (migration name misleading) |
| 5   | Public sign-up disabled                      | ❌ Enabled at platform level           |
| 6   | RPC inventory vs production                  | ⚠️ Not verified — execution avoided    |
| 7   | `sbp_` publishable key                       | ❌ Invalid / rotated                   |

Nothing in this audit indicates active data exposure. Item 5 is a
documentation-accuracy and defence-in-depth issue rather than a live breach, and
items 6 and 7 are follow-ups.

---

## Reproducing

Use an `anon`-scoped key only. Never paste a service-role key into a shell that
logs history, and never commit one.

```bash
BASE=https://<project-ref>.supabase.co

# Auth configuration
curl -s -H "apikey: $ANON" "$BASE/auth/v1/settings"

# Row count for one table (0 means RLS is denying anon)
curl -s -D - -o /dev/null \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "Prefer: count=exact" -H "Range: 0-0" \
  "$BASE/rest/v1/qualified_leads?select=*&limit=1"

# Public-bucket test: compare against a bucket name you know does not exist
curl -s "$BASE/storage/v1/object/public/lead-attachments/probe-missing.txt"
curl -s "$BASE/storage/v1/object/public/zzz-no-such-bucket-9999/probe.txt"
```

---

## Related

- [`known-issues.md`](known-issues.md) — item 5 is filed there
- [`architecture.md`](architecture.md) — how the app talks to this backend
- [`database-io-optimization.md`](database-io-optimization.md) — prior read-only audit
