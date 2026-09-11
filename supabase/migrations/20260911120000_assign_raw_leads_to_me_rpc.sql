-- Bulk "assign N Yes-leads to me" for the Raw Leads page.
--
-- Claims up to p_limit raw leads that are AI-approved (lead = 'yes'), still in
-- the "new" pool (category IS NULL) and unclaimed (assigned_to IS NULL /
-- assigned_myself_at IS NULL), assigning them to the calling user.
--
-- Concurrency: the candidate rows are locked with FOR UPDATE SKIP LOCKED, so
-- when several users press the button at the same time each transaction simply
-- takes the next rows that aren't already locked by another. No two users get
-- the same lead and no call fails on contention — a caller just receives fewer
-- rows when the pool is being drained concurrently. The function returns the
-- number of leads actually assigned.

CREATE OR REPLACE FUNCTION public.assign_raw_leads_to_me(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _n   integer;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Restrict to the roles that operate the Raw Leads page.
  IF NOT (
    public.current_user_has_role_text('admin')
    OR public.current_user_has_role_text('sub_admin')
    OR public.current_user_has_role_text('scraping')
    OR public.current_user_has_role_text('maturing')
    OR public.current_user_has_role_text('acc_handler')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 THEN
    RETURN 0;
  END IF;
  -- Safety cap so a bad client can't claim the whole pool in one call.
  p_limit := least(p_limit, 100);

  WITH picked AS (
    SELECT id
    FROM public.raw_lead_cache
    WHERE lead = 'yes'
      AND category IS NULL
      AND assigned_to IS NULL
      AND assigned_myself_at IS NULL
    ORDER BY captured_at DESC NULLS LAST, id DESC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.raw_lead_cache AS r
  SET assigned_to = _uid,
      assigned_myself_at = now()
  FROM picked
  WHERE r.id = picked.id;

  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.assign_raw_leads_to_me(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_raw_leads_to_me(integer) TO authenticated;
