-- Keep the interactive report fast as scrape volume grows. Matching is done
-- through small normalized key sets and indexed equality joins instead of OR
-- predicates that force broad scans.
DROP INDEX IF EXISTS public.idx_raw_lead_cache_incog_account_lower;
DROP INDEX IF EXISTS public.idx_raw_lead_cache_account_name_lower;

CREATE INDEX IF NOT EXISTS idx_incogniton_profiles_last_launched_at
  ON public.incogniton_profiles (last_launched_at DESC NULLS LAST);

CREATE OR REPLACE FUNCTION public.browser_profile_performance(
  _from timestamptz,
  _to timestamptz
)
RETURNS TABLE(
  profile_id uuid,
  profile_name text,
  incogniton_profile_id text,
  account_area text,
  profile_priority text,
  launch_count bigint,
  scraped_posts bigint,
  forwarded bigint,
  delivered bigint,
  cx_interested bigint,
  top_service text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH authorized AS (
    SELECT 1
    WHERE auth.uid() IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = auth.uid()
          AND ur.role::text IN ('admin', 'sub_admin', 'scraping', 'acc_handler')
      )
  ),
  profile_launches AS (
    SELECT
      p.id,
      p.profile_name,
      p.incogniton_profile_id,
      p.account_area,
      p.profile_priority,
      COUNT(history.entry)::bigint AS history_launch_count,
      p.last_launched_at
    FROM public.incogniton_profiles p
    CROSS JOIN authorized
    LEFT JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(p.launch_history) = 'array' THEN p.launch_history ELSE '[]'::jsonb END
    ) AS history(entry)
      ON NULLIF(history.entry->>'at', '')::timestamptz >= _from
     AND NULLIF(history.entry->>'at', '')::timestamptz < _to
    GROUP BY
      p.id,
      p.profile_name,
      p.incogniton_profile_id,
      p.account_area,
      p.profile_priority,
      p.last_launched_at
  ),
  launched_profiles AS MATERIALIZED (
    SELECT
      pl.*,
      CASE
        WHEN pl.history_launch_count > 0 THEN pl.history_launch_count
        WHEN pl.last_launched_at >= _from AND pl.last_launched_at < _to THEN 1
        ELSE 0
      END::bigint AS launches
    FROM profile_launches pl
    WHERE pl.history_launch_count > 0
       OR (pl.last_launched_at >= _from AND pl.last_launched_at < _to)
  ),
  profile_keys AS MATERIALIZED (
    SELECT
      lp.id AS profile_id,
      'id'::text AS match_kind,
      LOWER(TRIM(lp.incogniton_profile_id)) AS match_value
    FROM launched_profiles lp
    WHERE NULLIF(TRIM(lp.incogniton_profile_id), '') IS NOT NULL

    UNION ALL

    SELECT
      lp.id,
      'name'::text,
      LOWER(TRIM(lp.profile_name))
    FROM launched_profiles lp
    WHERE NULLIF(TRIM(lp.profile_name), '') IS NOT NULL
  ),
  scoped_raw_rows AS MATERIALIZED (
    SELECT
      r.id,
      r.category,
      r.canonical_post_id,
      r.canonical_lead_link,
      NULLIF(TRIM(r.data->>'Service / Category'), '') AS scraped_service,
      NULLIF(LOWER(TRIM(r.data->>'Incog Account')), '') AS incog_account,
      NULLIF(LOWER(TRIM(r.data->>'Account Name')), '') AS account_name
    FROM public.raw_lead_cache r
    WHERE r.captured_at >= _from
      AND r.captured_at < _to
  ),
  raw_keys AS (
    SELECT
      r.id,
      r.category,
      r.canonical_post_id,
      r.canonical_lead_link,
      r.scraped_service,
      candidate.match_kind,
      candidate.match_value,
      candidate.match_rank
    FROM scoped_raw_rows r
    CROSS JOIN LATERAL (
      VALUES
        ('id'::text, r.incog_account, 0),
        ('name'::text, r.incog_account, 1),
        ('name'::text, r.account_name, 2)
    ) AS candidate(match_kind, match_value, match_rank)
    WHERE candidate.match_value IS NOT NULL
  ),
  matched_raw AS MATERIALIZED (
    SELECT DISTINCT ON (rk.id)
      rk.id,
      rk.category,
      rk.canonical_post_id,
      rk.canonical_lead_link,
      rk.scraped_service,
      pk.profile_id
    FROM raw_keys rk
    JOIN profile_keys pk
      ON pk.match_kind = rk.match_kind
     AND pk.match_value = rk.match_value
    ORDER BY rk.id, rk.match_rank, pk.profile_id
  ),
  qualified_candidates AS (
    SELECT
      sr.id AS raw_id,
      q.id AS qualified_id,
      q.cs_status,
      q.service,
      q.pass_it_to,
      0 AS match_rank
    FROM matched_raw sr
    JOIN public.qualified_leads q ON q.raw_lead_cache_id = sr.id

    UNION ALL

    SELECT
      sr.id,
      q.id,
      q.cs_status,
      q.service,
      q.pass_it_to,
      1
    FROM matched_raw sr
    JOIN public.qualified_leads q
      ON q.raw_lead_cache_id IS NULL
     AND sr.canonical_post_id IS NOT NULL
     AND q.canonical_post_id = sr.canonical_post_id

    UNION ALL

    SELECT
      sr.id,
      q.id,
      q.cs_status,
      q.service,
      q.pass_it_to,
      2
    FROM matched_raw sr
    JOIN public.qualified_leads q
      ON q.raw_lead_cache_id IS NULL
     AND sr.canonical_lead_link IS NOT NULL
     AND q.canonical_lead_link = sr.canonical_lead_link
  ),
  matched_qualified AS (
    SELECT DISTINCT ON (raw_id)
      raw_id,
      qualified_id,
      cs_status,
      service,
      pass_it_to
    FROM qualified_candidates
    ORDER BY raw_id, match_rank, qualified_id
  ),
  lead_links AS (
    SELECT
      sr.profile_id,
      sr.id AS raw_id,
      sr.category,
      q.qualified_id,
      q.cs_status,
      COALESCE(
        sr.scraped_service,
        NULLIF(TRIM(q.service), ''),
        NULLIF(TRIM(q.pass_it_to), '')
      ) AS service
    FROM matched_raw sr
    LEFT JOIN matched_qualified q ON q.raw_id = sr.id
  ),
  totals AS (
    SELECT
      profile_id,
      COUNT(*)::bigint AS scraped_posts,
      COUNT(*) FILTER (
        WHERE category = 'forwarded' OR qualified_id IS NOT NULL
      )::bigint AS forwarded,
      COUNT(DISTINCT qualified_id) FILTER (WHERE cs_status = 'converted')::bigint AS delivered,
      COUNT(DISTINCT qualified_id) FILTER (WHERE cs_status = 'cx_interested')::bigint AS cx_interested
    FROM lead_links
    GROUP BY profile_id
  ),
  service_counts AS (
    SELECT
      profile_id,
      service,
      COUNT(*)::bigint AS service_count
    FROM lead_links
    WHERE service IS NOT NULL
    GROUP BY profile_id, service
  ),
  top_services AS (
    SELECT DISTINCT ON (profile_id)
      profile_id,
      service
    FROM service_counts
    ORDER BY profile_id, service_count DESC, service ASC
  )
  SELECT
    lp.id,
    lp.profile_name,
    lp.incogniton_profile_id,
    lp.account_area,
    lp.profile_priority,
    lp.launches,
    COALESCE(t.scraped_posts, 0)::bigint,
    COALESCE(t.forwarded, 0)::bigint,
    COALESCE(t.delivered, 0)::bigint,
    COALESCE(t.cx_interested, 0)::bigint,
    ts.service
  FROM launched_profiles lp
  LEFT JOIN totals t ON t.profile_id = lp.id
  LEFT JOIN top_services ts ON ts.profile_id = lp.id
  ORDER BY COALESCE(t.scraped_posts, 0) DESC, lp.profile_name ASC;
$$;

REVOKE ALL ON FUNCTION public.browser_profile_performance(timestamptz, timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.browser_profile_performance(timestamptz, timestamptz)
  TO authenticated;
