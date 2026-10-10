# Contributing to JellyBean

Internal project. This guide covers the workflow, the conventions the codebase
already follows, and the checks expected before review.

For system context read the [README](README.md) and
[`docs/architecture.md`](docs/architecture.md) first.

---

## Getting set up

```bash
bun install
cp .env.example .env      # fill in SUPABASE_* and OPENAI_API_KEY
supabase db push
bun dev                   # http://localhost:8080
```

Requires [Bun](https://bun.sh) ≥ 1.0 (Node 22 also works — see `.nvmrc`) and
access to a Supabase project.

`bunfig.toml` sets a 24-hour `minimumReleaseAge` supply-chain guard, so a fresh
release will not install until it is a day old. If you genuinely need to bypass
it for one package, add it to `minimumReleaseAgeExcludes` — and say why in the
PR.

### Creating the first admin

`/setup` works only while the project has **zero** profiles and **zero** admins.
It force-assigns the `admin` role. Once your first admin exists the route is
effectively closed.

---

## Branching and commits

Branch from `main` with a descriptive prefix:

```
kashif/short-description
feat/short-description
fix/short-description
```

Commits and **PR titles** follow [Conventional Commits](https://www.conventionalcommits.org/),
enforced by `.github/workflows/pr-title.yml`:

```
feat(raw-leads): auto-route duplicate leads
fix(cs-pipeline): use Eastern day boundary for follow-ups
docs(readme): document Crisp integration
style(lib): apply prettier
perf(realtime): drop duplicate subscriptions
refactor(lead-form): extract shared field group
test(service-assignment): cover trigger precedence
chore(deps): bump @tanstack/react-query
```

Types in use across this repo: `feat`, `fix`, `style`, `perf`, `refactor`,
`test`, `docs`, `chore`.

Keep commits focused. A formatting sweep and a behavioural change belong in
separate commits.

---

## Before you open a PR

```bash
bun run format        # prettier --write .
bun run lint          # eslint .
bunx tsc --noEmit     # type check (no script exists — run it directly)
bun run test:run      # vitest run
```

All four must be clean. Note there is **no** `typecheck` npm script and **no**
git hook — CI is the only automated gate, so running these locally is what
saves you a round trip.

> **Current baseline:** all three gates are clean — `tsc --noEmit` 0 errors,
> `eslint --max-warnings 0` 0 warnings, tests 46/46. Two known gaps are tracked in
> [`docs/known-issues.md`](docs/known-issues.md): `vitest` is not yet part of CI,
> and five `exhaustive-deps` suppressions in `app.crisp-chat.tsx` are intentional.

---

## Code conventions

### Formatting

Prettier runs **through ESLint** (`eslint-plugin-prettier/recommended`), so
`bun run lint` also checks formatting. Config: 100 columns, semicolons, double
quotes, trailing commas, LF endings.

### TypeScript

`strict: true`. Two notable relaxations, both intentional:

- `noUnusedLocals` / `noUnusedParameters` are `false`
- `@typescript-eslint/no-unused-vars` is `off`

So unused variables are **not** flagged. Clean them up yourself.

`import type` for type-only imports. Avoid `any` — `eslint` will catch it, and
several existing `TS2589` errors stem from over-broad generic instantiation.

### Server functions

Every `createServerFn` gets a middleware and a validator:

```ts
export const doThing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // …
  });
```

Use the **request-scoped** client from `context` so Postgres RLS applies under
the real user's identity. Reach for `supabaseAdmin` (service role, bypasses RLS)
only where RLS genuinely cannot express the rule — and never leak its results to
a caller who should not see them.

Only two functions intentionally skip auth, both documented inline:
`bootstrapFirstAdmin` and `saveGoogleSheetsConfigServerFn`.

### Authorization

If you add a route, you are adding four things:

1. The route file
2. A `RoleGate` with an explicit `allow` list
3. A navigation entry in `src/components/app-shell.tsx` (`itemsForRole`)
4. RLS coverage in a new migration

Skipping any of them produces a route that renders but is not actually
protected. The layers are independent on purpose.

### Adding a role

Four coordinated edits: the `AppRole` union (`src/hooks/use-auth.ts:14`), the
Postgres `app_role` enum, `itemsForRole()` (`src/components/app-shell.tsx:128`),
and `USER_MANAGEMENT_ROLES` (`src/lib/user-management-permissions.ts`) if the
role should be manageable by a manager.

### Client state

TanStack Query for server state, React Context for genuinely global client state
(auth, confirm dialog), `useState` for everything else. No new global store.

### Timezones

Do not call `new Date()` directly in a component. Use
`src/lib/timezone.ts` (PKT, app-wide) or `src/lib/cs-pipeline-time.ts`
(Eastern, CS Pipeline only). The split is deliberate; see
[`docs/architecture.md`](docs/architecture.md) §6.

### Realtime

One channel per concern, subscriptions scoped by role, and every realtime path
keeps its polling fallback. Before adding a channel, check whether
`ROLE_TABLES` in `src/hooks/use-realtime-sync.ts` already covers the table.

### Database

```bash
supabase migration new add_something
```

Never edit an applied migration — add a new one. Prefer a targeted RPC over a
broad `select *` on hot paths; the query patterns in
[`docs/database-io-optimization.md`](docs/database-io-optimization.md) exist
because broad reads dominated database cost.

### Testing

Vitest, colocated as `<module>.test.ts`. Cover pure logic: parsers, pagination
maths, time boundaries, permission rules, precedence chains.

There is no component or E2E layer. When you fix a bug, add the case that would
have caught it.

---

## Secrets

- **Never** commit a `.env` file, service-role key, or OpenAI key.
- **Never** put a secret in a `VITE_`-prefixed variable — Vite inlines those into
  the browser bundle.
- Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are meant to be
  publicly visible.
- If a secret is ever committed, rotating it is the fix. Removing it from the
  history is not sufficient.

---

## Review checklist

- [ ] `bun run format`, `bun run lint`, `bunx tsc --noEmit`, `bun run test:run` all clean
- [ ] Conventional Commit title
- [ ] New route has a `RoleGate`, a nav entry, and RLS coverage
- [ ] Server functions validate input with Zod and use the request-scoped client
- [ ] No secret in a `VITE_` variable
- [ ] Timezone helpers used instead of raw `new Date()`
- [ ] Realtime changes keep a polling fallback
- [ ] New logic has a test; bug fixes have a regression test
- [ ] Docs updated if behaviour or setup changed
- [ ] Migration added rather than an existing one edited

---

## Where things live

| Looking for       | Go to                                                 |
| ----------------- | ----------------------------------------------------- |
| A page            | `src/routes/app.*.tsx`                                |
| Shared form       | `src/components/lead-form.tsx`                        |
| Server-side logic | `src/lib/*.functions.ts`                              |
| Pure helpers      | `src/lib/*.ts`                                        |
| Database types    | `src/integrations/supabase/types.ts` (generated)      |
| Auth wiring       | `src/hooks/use-auth.ts`, `src/integrations/supabase/` |
| Design system     | `src/styles.css`, `src/components/ui/`                |
| SQL               | `supabase/migrations/`                                |
| Edge functions    | `supabase/functions/`                                 |
| Open defects      | [`docs/known-issues.md`](docs/known-issues.md)        |
