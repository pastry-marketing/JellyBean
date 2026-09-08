import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { normalizePhone } from "./crm-lite";
import { buildRawLeadKeysetFilter } from "./raw-leads-keyset";

const ALLOWED_RAW_LEAD_ROLES = [
  "admin",
  "sub_admin",
  "scraping",
  "maturing",
  "acc_handler",
] as const;

type RawLeadRole = (typeof ALLOWED_RAW_LEAD_ROLES)[number];

export type RawLeadCacheRow = {
  id?: string;
  row_key: string;
  data: Record<string, string>;
  lead: "yes" | "no" | "review" | null;
  phone: string | null;
  category: "forwarded" | "not_found" | "wrong" | "duplicate" | null;
  captured_at: string | null;
  lead_link: string | null;
  sheet_row: number | null;
  assigned_to: string | null;
  assigned_myself_at: string | null;
  duplicate_detected?: boolean | null;
  duplicate_reason?: string | null;
  duplicate_match_type?: string | null;
  duplicate_key?: string | null;
  duplicate_of_raw_lead_id?: string | null;
  duplicate_of_qualified_lead_id?: string | null;
  canonical_post_id?: string | null;
  canonical_lead_link?: string | null;
};

export type CacheEntry = RawLeadCacheRow;

function normalizeLead(value: string | null): "yes" | "no" | "review" | null {
  return value === "yes" || value === "no" || value === "review" ? value : null;
}

function normalizeCategory(value: string | null): RawLeadCacheRow["category"] {
  return value === "forwarded" ||
    value === "not_found" ||
    value === "wrong" ||
    value === "duplicate"
    ? value
    : null;
}

function normalizeData(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, entry == null ? "" : String(entry)]),
  );
}

const CATEGORY_FILTERS = [
  "all",
  "new",
  "review",
  "forwarded",
  "not_found",
  "wrong",
  "duplicate",
  "assigned_myself",
] as const;
type CategoryFilter = (typeof CATEGORY_FILTERS)[number];
const DUPLICATE_LOOKBACK_HOURS = 48;

const LEAD_FILTERS = ["all", "yes", "no", "review"] as const;
type LeadFilter = (typeof LEAD_FILTERS)[number];

const DUPLICATE_FILTERS = ["all", "duplicates", "unique"] as const;
type DuplicateFilter = (typeof DUPLICATE_FILTERS)[number];

function escapeIlikeValue(value: string) {
  return value.replace(/[%_]/g, "\\$&").replace(/,/g, " ");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applySearchAndFilters<T extends { eq: (...a: never[]) => T; or: (...a: never[]) => T }>(
  query: T,
  filters: { query: string; leadFilter: LeadFilter; areaFilter: string; duplicateFilter: DuplicateFilter },
): T {
  let next = query;
  const trimmedQuery = filters.query.trim();
  if (trimmedQuery) {
    const pattern = `%${escapeIlikeValue(trimmedQuery)}%`;
    next = next.or(
      [
        `phone.ilike.${pattern}`,
        `lead_link.ilike.${pattern}`,
        `data->>Account Name.ilike.${pattern}`,
        `data->>Post Text.ilike.${pattern}`,
        `data->>Account Area.ilike.${pattern}`,
        `data->>Sub Area / Neighborhood.ilike.${pattern}`,
        `data->>Incog Account.ilike.${pattern}`,
      ].join(",") as never,
    );
  }
  if (filters.leadFilter !== "all") {
    next = next.eq("lead" as never, filters.leadFilter as never);
  }
  if (filters.areaFilter !== "all") {
    next = next.or(
      `data->>Account Area.eq.${filters.areaFilter},data->>Sub Area / Neighborhood.eq.${filters.areaFilter}` as never,
    );
  }
  if (filters.duplicateFilter === "duplicates") {
    next = (next as unknown as { eq: (c: string, v: boolean) => T }).eq("duplicate_detected", true);
  } else if (filters.duplicateFilter === "unique") {
    next = (next as unknown as { or: (s: string) => T }).or(
      "duplicate_detected.is.null,duplicate_detected.eq.false",
    );
  }
  return next;
}

// Alias for local readability — canonical implementation is in crm-lite.
const normalizePhoneDigits = normalizePhone;

export const fetchRawLeadCache = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        limit: z.number().int().min(1).max(500).default(500),
        offset: z.number().int().min(0).default(0),
        category: z.enum(CATEGORY_FILTERS).default("all"),
        query: z.string().max(120).default(""),
        leadFilter: z.enum(LEAD_FILTERS).default("all"),
        areaFilter: z.string().max(120).default("all"),
        duplicateFilter: z.enum(DUPLICATE_FILTERS).default("all"),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    
    const { data: rolesData, error: rolesError } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (rolesError) throw new Error(rolesError.message);

    const roles = (rolesData ?? []).map((row) => row.role as string);
    const hasAllowedRole = roles.some((role): role is RawLeadRole =>
      ALLOWED_RAW_LEAD_ROLES.includes(role as RawLeadRole),
    );
    if (!hasAllowedRole) throw new Error("Forbidden: raw leads access required");

    const isAdmin = roles.includes("admin") || roles.includes("sub_admin");
    const columns =
      "id, row_key, data, lead, phone, category, captured_at, lead_link, sheet_row, assigned_to, assigned_myself_at, duplicate_detected, duplicate_reason, duplicate_match_type, duplicate_key, duplicate_of_raw_lead_id, duplicate_of_qualified_lead_id, canonical_post_id, canonical_lead_link";

    const applyCategory = <T extends {
      is: (...a: never[]) => T;
      eq: (...a: never[]) => T;
      not: (...a: never[]) => T;
      or: (...a: never[]) => T;
    }>(
      query: T,
      category: CategoryFilter,
    ): T => {
      if (category === "new") {
        // Uncategorized AND not yet claimed. Claimed leads move to
        // "Assigned Myself" (for the owner) and are hidden from New for
        // everyone — same filter for all users so the list stays stable.
        return query
          .is("category" as never, null as never)
          .is("assigned_myself_at" as never, null as never);
      }
      if (
        category === "forwarded" ||
        category === "not_found" ||
        category === "wrong" ||
        category === "duplicate"
      )
        return query.eq("category" as never, category as never);
      return query;
    };

    const applyAssignment = <T extends { or: (...a: never[]) => T; eq: (...a: never[]) => T }>(
      query: T,
      category: CategoryFilter,
    ): T => {
      // Only the "Assigned Myself" tab scopes by owner. Every other tab is
      // shared across the team so a self-assignment by one user never
      // removes a lead from another user's view.
      if (category === "assigned_myself")
        return query.eq("assigned_to" as never, context.userId as never);
      void isAdmin;
      return query;
    };

    // Paged data
    let dataQuery = context.supabase
      .from("raw_lead_cache")
      .select(columns)
      .order("captured_at", { ascending: false, nullsFirst: false })
      .range(data.offset, data.offset + data.limit - 1);
    // Raw leads that the current user has parked as Drafts must be hidden
    // from the live Raw Leads views (New, Assigned Myself, etc.) — they live
    // only inside the Drafts dialog until sent or discarded.
    const { data: draftRows, error: draftError } = await context.supabase
      .from("lead_drafts" as never)
      .select("source_lead_id")
      .eq("created_by" as never, context.userId as never)
      .eq("source_type" as never, "raw_lead" as never)
      .not("source_lead_id" as never, "is" as never, null as never);
    if (draftError) throw new Error(draftError.message);
    const draftedIds = ((draftRows ?? []) as Array<{ source_lead_id: string | null }>)
      .map((r) => r.source_lead_id)
      .filter((v): v is string => !!v);
    const excludeDrafts = <T extends { not: (...a: never[]) => T }>(q: T): T =>
      draftedIds.length
        ? (q.not("id" as never, "in" as never, `(${draftedIds.join(",")})` as never) as T)
        : q;

    // For assigned_myself tab: show leads self-assigned by the user that are
    // still active (category IS NULL = not yet forwarded/wrong/etc.).
    if (data.category === "assigned_myself") {
      dataQuery = dataQuery
        .eq("assigned_to" as never, context.userId as never)
        .not("assigned_myself_at" as never, "is" as never, null as never)
        .is("category" as never, null as never) as typeof dataQuery;
    } else {
      dataQuery = applyCategory(dataQuery as never, data.category) as typeof dataQuery;
      dataQuery = applyAssignment(dataQuery as never, data.category) as typeof dataQuery;
    }
    dataQuery = excludeDrafts(dataQuery as never) as typeof dataQuery;
    dataQuery = applySearchAndFilters(dataQuery as never, {
      query: data.query,
      leadFilter: data.leadFilter,
      areaFilter: data.areaFilter,
      duplicateFilter: data.duplicateFilter,
    }) as typeof dataQuery;
    const { data: rows, error } = await dataQuery;
    if (error) throw new Error(error.message);

    // Exact count only when a search/filter narrows the set (indexes keep it
    // cheap). Unfiltered tabs reuse the single grouped aggregate below, so no
    // extra full scan runs per page.
    const hasNarrowingFilters =
      data.category === "all" ||
      data.category === "review" ||
      !!data.query?.trim() ||
      (data.leadFilter && data.leadFilter !== "all") ||
      (data.areaFilter && data.areaFilter !== "all") ||
      (data.duplicateFilter && data.duplicateFilter !== "all") ||
      draftedIds.length > 0;

    let totalForCategory = 0;
    if (hasNarrowingFilters) {
      let totalCountQuery = context.supabase
        .from("raw_lead_cache")
        .select("row_key", { count: "exact", head: true });
      if (data.category === "assigned_myself") {
        totalCountQuery = totalCountQuery
          .eq("assigned_to" as never, context.userId as never)
          .not("assigned_myself_at" as never, "is" as never, null as never)
          .is("category" as never, null as never) as typeof totalCountQuery;
      } else {
        totalCountQuery = applyCategory(totalCountQuery as never, data.category) as typeof totalCountQuery;
        totalCountQuery = applyAssignment(totalCountQuery as never, data.category) as typeof totalCountQuery;
      }
      totalCountQuery = excludeDrafts(totalCountQuery as never) as typeof totalCountQuery;
      totalCountQuery = applySearchAndFilters(totalCountQuery as never, {
        query: data.query,
        leadFilter: data.leadFilter,
        areaFilter: data.areaFilter,
        duplicateFilter: data.duplicateFilter,
      }) as typeof totalCountQuery;
      const { count, error: totalForCategoryError } = await totalCountQuery;
      if (totalForCategoryError) throw new Error(totalForCategoryError.message);
      totalForCategory = count ?? 0;
    } else {
      // One grouped aggregate for every tab badge — reused as the page total.
      const { data: countsJson, error: countsError } = await context.supabase.rpc(
        "raw_lead_cache_category_counts_json" as never,
        { _user_id: context.userId, _is_admin: isAdmin } as never,
      );
      if (countsError) throw new Error(countsError.message);
      const rawCounts = (countsJson ?? {}) as Record<string, number | string | null>;
      totalForCategory = Number(rawCounts[data.category] ?? 0) || 0;
    }


    const entries: RawLeadCacheRow[] = (rows ?? []).map((entry) => ({
      row_key: entry.row_key,
      id: (entry as Record<string, unknown>).id as string,
      data: normalizeData(entry.data),
      lead: normalizeLead(entry.lead),
      phone: entry.phone,
      category: normalizeCategory(entry.category),
      captured_at: entry.captured_at,
      lead_link: entry.lead_link,
      sheet_row: entry.sheet_row,
      assigned_to: entry.assigned_to,
      assigned_myself_at: (entry as Record<string, unknown>).assigned_myself_at as string | null ?? null,
      duplicate_detected: ((entry as Record<string, unknown>).duplicate_detected as boolean | null) ?? null,
      duplicate_reason: ((entry as Record<string, unknown>).duplicate_reason as string | null) ?? null,
      duplicate_match_type: ((entry as Record<string, unknown>).duplicate_match_type as string | null) ?? null,
      duplicate_key: ((entry as Record<string, unknown>).duplicate_key as string | null) ?? null,
      duplicate_of_raw_lead_id: ((entry as Record<string, unknown>).duplicate_of_raw_lead_id as string | null) ?? null,
      duplicate_of_qualified_lead_id: ((entry as Record<string, unknown>).duplicate_of_qualified_lead_id as string | null) ?? null,
      canonical_post_id: ((entry as Record<string, unknown>).canonical_post_id as string | null) ?? null,
      canonical_lead_link: ((entry as Record<string, unknown>).canonical_lead_link as string | null) ?? null,
    }));

    return {
      entries,
      totalCount: totalForCategory,
      counts: {
        new: 0,
        forwarded: 0,
        not_found: 0,
        wrong: 0,
        duplicate: 0,
        assigned_myself: 0,
      },
      pageSize: data.limit,
      offset: data.offset,
      hasMore: data.offset + entries.length < totalForCategory,
      nextOffset: data.offset + entries.length < totalForCategory ? data.offset + data.limit : null,
    };
  });

export const fetchRawLeadKeyset = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        limit: z.number().int().min(1).max(500).default(500),
        cursor: z
          .object({
            captured_at: z.string().nullable(),
            id: z.string(),
          })
          .nullable()
          .default(null),
        direction: z.enum(["next", "previous", "last"]).default("next"),
        lastPageSize: z.number().int().min(0).max(500).optional(),
        category: z.enum(CATEGORY_FILTERS).default("all"),
        query: z.string().max(120).default(""),
        leadFilter: z.enum(LEAD_FILTERS).default("all"),
        areaFilter: z.string().max(120).default("all"),
        duplicateFilter: z.enum(DUPLICATE_FILTERS).default("all"),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { data: rolesData, error: rolesError } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (rolesError) throw new Error(rolesError.message);

    const roles = (rolesData ?? []).map((row) => row.role as string);
    const hasAllowedRole = roles.some((role): role is RawLeadRole =>
      ALLOWED_RAW_LEAD_ROLES.includes(role as RawLeadRole),
    );
    if (!hasAllowedRole) throw new Error("Forbidden: raw leads access required");

    const isAdmin = roles.includes("admin") || roles.includes("sub_admin");
    const columns =
      "id, row_key, data, lead, phone, category, captured_at, lead_link, sheet_row, assigned_to, assigned_myself_at, duplicate_detected, duplicate_reason, duplicate_match_type, duplicate_key, duplicate_of_raw_lead_id, duplicate_of_qualified_lead_id, canonical_post_id, canonical_lead_link";

    const applyCategory = <T extends {
      is: (...a: never[]) => T;
      eq: (...a: never[]) => T;
      not: (...a: never[]) => T;
      or: (...a: never[]) => T;
    }>(
      query: T,
      category: CategoryFilter,
    ): T => {
      if (category === "new") {
        return query
          .is("category" as never, null as never)
          .is("assigned_myself_at" as never, null as never);
      }
      if (
        category === "forwarded" ||
        category === "not_found" ||
        category === "wrong" ||
        category === "duplicate"
      )
        return query.eq("category" as never, category as never);
      return query;
    };

    const applyAssignment = <T extends { or: (...a: never[]) => T; eq: (...a: never[]) => T }>(
      query: T,
      category: CategoryFilter,
    ): T => {
      if (category === "assigned_myself")
        return query.eq("assigned_to" as never, context.userId as never);
      void isAdmin;
      return query;
    };

    // Paged data
    let dataQuery = context.supabase
      .from("raw_lead_cache")
      .select(columns);

    if (data.direction === "next") {
      dataQuery = dataQuery
        .order("captured_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false })
        .limit(data.limit + 1);

      if (data.cursor) {
        dataQuery = dataQuery.or(buildRawLeadKeysetFilter(data.cursor, "next") as never) as typeof dataQuery;
      }
    } else if (data.direction === "previous") {
      dataQuery = dataQuery
        .order("captured_at", { ascending: true, nullsFirst: true })
        .order("id", { ascending: true })
        .limit(data.limit + 1);

      if (data.cursor) {
        dataQuery = dataQuery.or(buildRawLeadKeysetFilter(data.cursor, "previous") as never) as typeof dataQuery;
      }
    } else if (data.direction === "last") {
      // Reverse order to grab the absolute oldest chunk
      dataQuery = dataQuery
        .order("captured_at", { ascending: true, nullsFirst: true })
        .order("id", { ascending: true })
        .limit(data.lastPageSize ?? data.limit);
    }

    const { data: draftRows, error: draftError } = await context.supabase
      .from("lead_drafts" as never)
      .select("source_lead_id")
      .eq("created_by" as never, context.userId as never)
      .eq("source_type" as never, "raw_lead" as never)
      .not("source_lead_id" as never, "is" as never, null as never);
    if (draftError) throw new Error(draftError.message);
    const draftedIds = ((draftRows ?? []) as Array<{ source_lead_id: string | null }>)
      .map((r) => r.source_lead_id)
      .filter((v): v is string => !!v);
    const excludeDrafts = <T extends { not: (...a: never[]) => T }>(q: T): T =>
      draftedIds.length
        ? (q.not("id" as never, "in" as never, `(${draftedIds.join(",")})` as never) as T)
        : q;

    if (data.category === "assigned_myself") {
      dataQuery = dataQuery
        .eq("assigned_to" as never, context.userId as never)
        .not("assigned_myself_at" as never, "is" as never, null as never)
        .is("category" as never, null as never) as typeof dataQuery;
    } else {
      dataQuery = applyCategory(dataQuery as never, data.category) as typeof dataQuery;
      dataQuery = applyAssignment(dataQuery as never, data.category) as typeof dataQuery;
    }
    dataQuery = excludeDrafts(dataQuery as never) as typeof dataQuery;
    dataQuery = applySearchAndFilters(dataQuery as never, {
      query: data.query,
      leadFilter: data.leadFilter,
      areaFilter: data.areaFilter,
      duplicateFilter: data.duplicateFilter,
    }) as typeof dataQuery;

    const { data: rows, error } = await dataQuery;
    if (error) throw new Error(error.message);

    let fetchedRows = rows ?? [];
    let hasMore = false;

    if (data.direction === "next") {
      if (fetchedRows.length > data.limit) {
        hasMore = true;
        fetchedRows = fetchedRows.slice(0, data.limit);
      }
    } else if (data.direction === "previous") {
      if (fetchedRows.length > data.limit) {
        hasMore = true;
        fetchedRows = fetchedRows.slice(0, data.limit);
      }
      fetchedRows = fetchedRows.reverse();
    } else if (data.direction === "last") {
      // Reverse in memory so it renders top-down from newest to oldest
      fetchedRows = fetchedRows.reverse();
    }

    const entries: RawLeadCacheRow[] = fetchedRows.map((entry) => ({
      row_key: entry.row_key,
      id: (entry as Record<string, unknown>).id as string,
      data: normalizeData(entry.data),
      lead: normalizeLead(entry.lead),
      phone: entry.phone,
      category: normalizeCategory(entry.category),
      captured_at: entry.captured_at,
      lead_link: entry.lead_link,
      sheet_row: entry.sheet_row,
      assigned_to: entry.assigned_to,
      assigned_myself_at: (entry as Record<string, unknown>).assigned_myself_at as string | null ?? null,
      duplicate_detected: ((entry as Record<string, unknown>).duplicate_detected as boolean | null) ?? null,
      duplicate_reason: ((entry as Record<string, unknown>).duplicate_reason as string | null) ?? null,
      duplicate_match_type: ((entry as Record<string, unknown>).duplicate_match_type as string | null) ?? null,
      duplicate_key: ((entry as Record<string, unknown>).duplicate_key as string | null) ?? null,
      duplicate_of_raw_lead_id: ((entry as Record<string, unknown>).duplicate_of_raw_lead_id as string | null) ?? null,
      duplicate_of_qualified_lead_id: ((entry as Record<string, unknown>).duplicate_of_qualified_lead_id as string | null) ?? null,
      canonical_post_id: ((entry as Record<string, unknown>).canonical_post_id as string | null) ?? null,
      canonical_lead_link: ((entry as Record<string, unknown>).canonical_lead_link as string | null) ?? null,
    }));

    return {
      entries,
      pageSize: data.limit,
      hasMore,
    };
  });

export const fetchRawLeadKeysetCount = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        category: z.enum(CATEGORY_FILTERS).default("all"),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { data: rolesData, error: rolesError } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (rolesError) throw new Error(rolesError.message);

    const roles = (rolesData ?? []).map((row) => row.role as string);
    const hasAllowedRole = roles.some((role): role is RawLeadRole =>
      ALLOWED_RAW_LEAD_ROLES.includes(role as RawLeadRole),
    );
    if (!hasAllowedRole) throw new Error("Forbidden: raw leads access required");

    const isAdmin = roles.includes("admin") || roles.includes("sub_admin");

    const applyCategory = <T extends {
      is: (...a: never[]) => T;
      eq: (...a: never[]) => T;
      not: (...a: never[]) => T;
      or: (...a: never[]) => T;
    }>(
      query: T,
      category: CategoryFilter,
    ): T => {
      if (category === "new") {
        return query
          .is("category" as never, null as never)
          .is("assigned_myself_at" as never, null as never);
      }
      if (
        category === "forwarded" ||
        category === "not_found" ||
        category === "wrong" ||
        category === "duplicate"
      )
        return query.eq("category" as never, category as never);
      return query;
    };

    const applyAssignment = <T extends { or: (...a: never[]) => T; eq: (...a: never[]) => T }>(
      query: T,
      category: CategoryFilter,
    ): T => {
      if (category === "assigned_myself")
        return query.eq("assigned_to" as never, context.userId as never);
      void isAdmin;
      return query;
    };

    let countQuery = context.supabase
      .from("raw_lead_cache")
      .select("row_key", { count: "exact", head: true });

    const { data: draftRows, error: draftError } = await context.supabase
      .from("lead_drafts" as never)
      .select("source_lead_id")
      .eq("created_by" as never, context.userId as never)
      .eq("source_type" as never, "raw_lead" as never)
      .not("source_lead_id" as never, "is" as never, null as never);
    if (draftError) throw new Error(draftError.message);
    const draftedIds = ((draftRows ?? []) as Array<{ source_lead_id: string | null }>)
      .map((r) => r.source_lead_id)
      .filter((v): v is string => !!v);
    const excludeDrafts = <T extends { not: (...a: never[]) => T }>(q: T): T =>
      draftedIds.length
        ? (q.not("id" as never, "in" as never, `(${draftedIds.join(",")})` as never) as T)
        : q;

    if (data.category === "assigned_myself") {
      countQuery = countQuery
        .eq("assigned_to" as never, context.userId as never)
        .not("assigned_myself_at" as never, "is" as never, null as never)
        .is("category" as never, null as never) as typeof countQuery;
    } else {
      countQuery = applyCategory(countQuery as never, data.category) as typeof countQuery;
      countQuery = applyAssignment(countQuery as never, data.category) as typeof countQuery;
    }
    countQuery = excludeDrafts(countQuery as never) as typeof countQuery;

    const { count, error } = await countQuery;
    if (error) throw new Error(error.message);

    return count ?? 0;
  });

export const fetchRawLeadCounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({}).parse(input ?? {}))
  .handler(async ({ context }) => {
    
    const { data: rolesData, error: rolesError } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (rolesError) throw new Error(rolesError.message);

    const roles = (rolesData ?? []).map((row) => row.role as string);
    const hasAllowedRole = roles.some((role): role is RawLeadRole =>
      ALLOWED_RAW_LEAD_ROLES.includes(role as RawLeadRole),
    );
    if (!hasAllowedRole) throw new Error("Forbidden: raw leads access required");

    const isAdmin = roles.includes("admin") || roles.includes("sub_admin");

    // Single scalar RPC (jsonb) served from the pre-aggregated materialized
    // view. Returns a scalar, so PostgREST does not wrap it in the
    // LIMIT/OFFSET set-returning query that was hitting statement timeouts.
    const { data: countsJson, error: countError } = await context.supabase.rpc(
      "raw_lead_cache_category_counts_json" as never,
      { _user_id: context.userId, _is_admin: isAdmin } as never,
    );
    if (countError) throw new Error(countError.message);

    const raw = (countsJson ?? {}) as Record<string, number | string | null>;
    const num = (key: string) => Number(raw[key] ?? 0) || 0;

    // Draft raw leads (parked by the current user) are hidden from the
    // Assigned Myself tab, so the badge must exclude them too.
    const { data: draftRowsForCounts } = await context.supabase
      .from("lead_drafts" as never)
      .select("source_lead_id")
      .eq("created_by" as never, context.userId as never)
      .eq("source_type" as never, "raw_lead" as never)
      .not("source_lead_id" as never, "is" as never, null as never);
    const draftedIdsForCounts = ((draftRowsForCounts ?? []) as Array<{ source_lead_id: string | null }>)
      .map((r) => r.source_lead_id)
      .filter((v): v is string => !!v);

    let draftedAssignedMyself = 0;
    if (draftedIdsForCounts.length) {
      // Bounded lookup by primary key — no full-table scan.
      const { count } = await context.supabase
        .from("raw_lead_cache")
        .select("row_key", { count: "exact", head: true })
        .in("id" as never, draftedIdsForCounts as never)
        .eq("assigned_to", context.userId)
        .not("assigned_myself_at", "is", null)
        .is("category", null);
      draftedAssignedMyself = count ?? 0;
    }

    return {
      new: num("new"),
      review: 0,
      forwarded: num("forwarded"),
      not_found: num("not_found"),
      wrong: num("wrong"),
      duplicate: num("duplicate"),
      assigned_myself: Math.max(0, num("assigned_myself") - draftedAssignedMyself),
    };
  });


export const checkDuplicatePhone = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        phone: z.string().default(""),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const target = normalizePhoneDigits(data.phone);
    if (target.length < 7) return { duplicate: false, matches: [] };

    // The RPC is SECURITY DEFINER and already enforces that the caller has a
    // role row. Call it with the authenticated user's client so any signed-in
    // user (submitter, facebook, seo, maturing, acc_handler, admin) can run
    // the duplicate check from the lead form.
    void context.userId;
    const duplicateSince = new Date(
      Date.now() - DUPLICATE_LOOKBACK_HOURS * 60 * 60 * 1000,
    ).toISOString();
    const { data: rows, error } = await context.supabase.rpc(
      "check_qualified_lead_phone_duplicates" as never,
      { _phone_digits: target, _since: duplicateSince } as never,
    );
    if (error) throw new Error(error.message);

    const matches = (
      (rows as unknown as Array<{
        id: string;
        customer_name: string;
        customer_number: string;
        customer_number_2: string | null;
        assigned_at: string;
      }> | null) ?? []
    )
      .slice(0, 10)
      .map((row) => ({
        id: row.id,
        customer_name: row.customer_name,
        customer_number: row.customer_number,
        customer_number_2: row.customer_number_2,
        assigned_at: row.assigned_at,
      }));

    const ids = matches.map((row) => row.id);
    const { data: details, error: detailsError } =
      ids.length === 0
        ? { data: [], error: null }
        : await context.supabase
            .from("qualified_leads")
            .select("id, service, context, main_area, sub_area, original_lead_link")
            .in("id", ids);
    if (detailsError) throw new Error(detailsError.message);

    const detailsById = new Map(
      ((details as Array<{
        id: string;
        service: string | null;
        context: string | null;
        main_area: string | null;
        sub_area: string | null;
        original_lead_link: string | null;
      }> | null) ?? []
      ).map((detail) => [detail.id, detail]),
    );

    return {
      duplicate: matches.length > 0,
      matches: matches.map((match) => {
        const detail = detailsById.get(match.id);
        return {
          ...match,
          service: detail?.service ?? null,
          context: detail?.context ?? null,
          main_area: detail?.main_area ?? null,
          sub_area: detail?.sub_area ?? null,
          original_lead_link: detail?.original_lead_link ?? null,
        };
      }),
    };
  });
