-- Connect forwarded leads to their scraped source row so profile performance
-- remains accurate even if a lead's status or service changes later.
ALTER TABLE public.qualified_leads
  ADD COLUMN IF NOT EXISTS raw_lead_cache_id uuid
  REFERENCES public.raw_lead_cache(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_qualified_leads_raw_lead_cache_id
  ON public.qualified_leads (raw_lead_cache_id)
  WHERE raw_lead_cache_id IS NOT NULL;

-- Backfill historical forwarded leads using the canonical identifiers that are
-- already indexed on both tables. Prefer the post id, then the canonical link,
-- and choose the closest capture when duplicate cache rows exist.
WITH matches AS (
  SELECT DISTINCT ON (q.id)
    q.id AS qualified_lead_id,
    r.id AS raw_lead_cache_id
  FROM public.qualified_leads q
  JOIN public.raw_lead_cache r
    ON (
      q.canonical_post_id IS NOT NULL
      AND r.canonical_post_id = q.canonical_post_id
    ) OR (
      q.canonical_lead_link IS NOT NULL
      AND r.canonical_lead_link = q.canonical_lead_link
    )
  WHERE q.raw_lead_cache_id IS NULL
  ORDER BY
    q.id,
    CASE WHEN q.canonical_post_id IS NOT NULL AND r.canonical_post_id = q.canonical_post_id
      THEN 0 ELSE 1 END,
    ABS(EXTRACT(EPOCH FROM (COALESCE(r.captured_at, r.created_at) - q.created_at)))
)
UPDATE public.qualified_leads q
SET raw_lead_cache_id = matches.raw_lead_cache_id
FROM matches
WHERE q.id = matches.qualified_lead_id;

CREATE INDEX IF NOT EXISTS idx_raw_lead_cache_incog_account_lower
  ON public.raw_lead_cache (LOWER(TRIM(data->>'Incog Account')));

CREATE INDEX IF NOT EXISTS idx_raw_lead_cache_account_name_lower
  ON public.raw_lead_cache (LOWER(TRIM(data->>'Account Name')));

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
  launched_profiles AS (
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
  scoped_raw AS (
    SELECT
      r.id,
      r.category,
      r.canonical_post_id,
      r.canonical_lead_link,
      NULLIF(TRIM(r.data->>'Service / Category'), '') AS scraped_service,
      matched.profile_id
    FROM public.raw_lead_cache r
    JOIN LATERAL (
      SELECT lp.id AS profile_id
      FROM launched_profiles lp
      WHERE
        LOWER(TRIM(r.data->>'Incog Account')) = LOWER(lp.incogniton_profile_id)
        OR LOWER(TRIM(r.data->>'Incog Account')) = LOWER(lp.profile_name)
        OR LOWER(TRIM(r.data->>'Account Name')) = LOWER(lp.profile_name)
      ORDER BY
        CASE
          WHEN LOWER(TRIM(r.data->>'Incog Account')) = LOWER(lp.incogniton_profile_id) THEN 0
          WHEN LOWER(TRIM(r.data->>'Incog Account')) = LOWER(lp.profile_name) THEN 1
          ELSE 2
        END,
        lp.id
      LIMIT 1
    ) matched ON true
    WHERE r.captured_at >= _from
      AND r.captured_at < _to
  ),
  lead_links AS (
    SELECT DISTINCT
      sr.profile_id,
      sr.id AS raw_id,
      sr.category,
      q.id AS qualified_id,
      q.cs_status,
      COALESCE(
        sr.scraped_service,
        NULLIF(TRIM(q.service), ''),
        NULLIF(TRIM(q.pass_it_to), '')
      ) AS service
    FROM scoped_raw sr
    LEFT JOIN public.qualified_leads q
      ON q.raw_lead_cache_id = sr.id
      OR (
        q.raw_lead_cache_id IS NULL
        AND (
          (sr.canonical_post_id IS NOT NULL AND q.canonical_post_id = sr.canonical_post_id)
          OR (sr.canonical_lead_link IS NOT NULL AND q.canonical_lead_link = sr.canonical_lead_link)
        )
      )
  ),
  totals AS (
    SELECT
      profile_id,
      COUNT(DISTINCT raw_id)::bigint AS scraped_posts,
      COUNT(DISTINCT raw_id) FILTER (
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
      COUNT(DISTINCT raw_id)::bigint AS service_count
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
