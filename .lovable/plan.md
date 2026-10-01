> # ⚠️ PROPOSAL — NEVER STARTED
>
> This 8-stage performance plan was drafted but **not implemented**. It is kept
> as a record of intent, not as a description of the system.
>
> Verified absent as of 2026-10-01 (`main` @ `a85f68a`):
>
> | Proposed here                                  | Actual state                                    |
> | ---------------------------------------------- | ----------------------------------------------- |
> | `src/lib/queries/*` (`queryOptions` factories) | Does not exist                                  |
> | `src/components/skeletons/*`                   | Does not exist; one `route-skeleton.tsx` only   |
> | `@tanstack/react-virtual`                      | Not a dependency; no list virtualisation        |
> | URL-driven pagination via `validateSearch`     | Only `/app/settings` and `/app/cs-leads` use it |
> | `useSuspenseQuery` route loaders               | Not used                                        |
> | Per-page `staleTime` tuning                    | Global 60 s in `src/router.tsx`                 |
>
> The document ends with "Confirm and I'll start with stage 1" — that
> confirmation never happened. Before acting on any stage, re-measure: some of
> its premises may no longer hold. See also
> [`docs/known-issues.md`](../docs/known-issues.md) §P6.

---

# CRM Performance Optimization Plan

Goal: sub-second transitions, smooth large-list rendering, fewer re-renders, smaller payloads, and consistent skeleton/loading UX across the app.

## Scope (in order of impact)

### 1. Data fetching layer (biggest win)

- Standardize on **TanStack Query** with `ensureQueryData` + `useSuspenseQuery` for route loaders (raw-leads, cs-leads, forwarded-leads, reports, cs-reports, analytics, submit-lead, browser-profiles, logs).
- Add sensible `staleTime` (30s for lists, 5m for lookups like users/areas) and `gcTime` (10m); disable `refetchOnWindowFocus` for heavy pages.
- Deduplicate parallel requests already fired from multiple components by centralizing `queryOptions` factories in `src/lib/queries/*.ts`.
- Keep row counts out of hot paths where possible (use `head:true, count:'estimated'` instead of `exact`) — matters for `raw_lead_cache` and `qualified_leads`.

### 2. Server-side pagination + search

- Raw Leads, CS Pipeline, Forwarded Leads, Logs: move to **URL-driven** `page/pageSize/query/filters` via `validateSearch` so pages are shareable and don't re-mount on state churn.
- Debounce search input at 250ms; cancel in-flight queries via `AbortController` passed through `queryFn`.
- Replace client-side `.filter().sort()` over full arrays with server queries (add DB indexes where missing — see §7).

### 3. Windowed rendering for large tables

- Introduce `@tanstack/react-virtual` for:
  - Raw Leads table
  - CS Pipeline table view
  - Forwarded Leads
  - Logs
- Keep row height stable; render ~15–20 visible rows regardless of page size.

### 4. Re-render / component hygiene

- Wrap heavy row components (`LeadCard`, `LeadRow`, `RawLeadRow`) in `React.memo` with explicit prop comparators.
- Memoize expensive derived values (`useMemo`) and event handlers (`useCallback`) at parent list level.
- Move dialogs (`LeadDetailDialog`, `LeadDrawer`, `DraftsDialog`, `DuplicateLeadDialog`) to lazy imports via `React.lazy` so they don't ship with the initial route bundle.
- Split `app.raw-leads.tsx` (currently monolithic) into row + toolbar + dialog modules to reduce re-render fan-out.

### 5. Asset & bundle optimization

- Audit icon imports: switch broad `lucide-react` imports to per-icon (already tree-shaken but verify no `import * as`).
- Lazy-load Leaflet map (`leaflet-map.tsx`) and ffmpeg (`video-compressor.ts`) — only load on the routes that need them.
- Route-level code splitting: verify each `src/routes/app.*.tsx` is its own chunk (TanStack does this by default, confirm no cross-route imports pulling everything together).
- Preload the LCP image on `index.tsx` via `head().links`.

### 6. Loading UX

- Add skeleton components (`src/components/skeletons/*`) for: table rows, card lists, stat cards, report tables.
- Use route `pendingComponent` with `pendingMs: 200`, `pendingMinMs: 300` for snappy transitions without flicker.
- Suspense boundaries at the section level, not the whole page, so filters/toolbar remain interactive during refetches.

### 7. Database / RPC tuning

- Run `supabase--slow_queries` to identify actual offenders.
- Add composite indexes likely missing:
  - `raw_lead_cache (category, captured_at DESC)`
  - `raw_lead_cache (assigned_to, category, assigned_myself_at)`
  - `qualified_leads (cs_status, assigned_at DESC)`
  - `activity_logs (created_at DESC)`
- Verify RPCs (`raw_lead_cache_category_counts`, `check_qualified_lead_phone_duplicates`) are `STABLE` and use indexes.

### 8. Realtime discipline

- Audit `use-realtime-sync.ts` and any `supabase.channel` usages: ensure single channel per page, filtered subscriptions (not full-table), and cleanup on unmount. Realtime events should invalidate queries, not push into local state.

## Out of scope

- Visual redesign — glassmorphism theme kept as-is.
- No new features. This is strictly perf + UX polish.

## Technical notes

```text
src/lib/queries/
  raw-leads.ts        // queryOptions factories
  qualified-leads.ts
  reports.ts
  users.ts
src/components/skeletons/
  table-skeleton.tsx
  stat-card-skeleton.tsx
src/components/virtualized/
  virtual-table.tsx   // shared virtualizer wrapper
```

Order of execution (staged, each independently shippable):

1. Query layer + skeletons (foundational; unlocks the rest)
2. URL-driven pagination + debounced search on Raw Leads → CS Pipeline → Forwarded Leads → Logs
3. Virtualization on the same four tables
4. React.memo pass + lazy dialogs
5. DB indexes + slow-query fixes
6. Realtime audit

## Verification per stage

- Chrome DevTools Performance recording on Raw Leads and CS Pipeline before/after (target: <200ms interaction, <1s route transition on cached data).
- React DevTools Profiler: no row should re-render on unrelated state changes.
- Network tab: no duplicate concurrent requests to the same endpoint.
- Typecheck + build pass after each stage.

Confirm and I'll start with stage 1 (query layer + skeletons).
