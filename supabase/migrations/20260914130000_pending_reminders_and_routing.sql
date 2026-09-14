-- Pending-leads reminders: routing, permissions, and shared visibility.
--
-- Changes:
--   1. send_lead_reminder
--        • Any authenticated user holding a CRM role may send (was limited to
--          admin/sub_admin/maturing/acc_handler/facebook/seo).
--        • Reminders are blocked on "Processed" leads (cs_status = 'converted').
--        • For an ASSIGNED lead the reminder now goes to the assigned CS user
--          AND every active cs_admin (was: assigned CS only).
--        • Unassigned leads still broadcast to all active CS users (unchanged).
--   2. count_pending_reminder_leads() — number of DISTINCT leads that still have
--      an unread reminder. Powers the blinking sidebar dot. SECURITY DEFINER so
--      cs / cs_admin / admin can see the shared total regardless of who each
--      reminder was addressed to.
--   3. list_pending_reminder_leads() — the leads behind that count, for the new
--      "Pending leads" tab. Visible to admin / sub_admin / cs / cs_admin.
--   4. acknowledge_lead_reminders(_lead_id) — marks every unread reminder on a
--      lead as read, removing it from the Pending leads tab for everyone.

-- ── 1. send_lead_reminder ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.send_lead_reminder(_lead_id uuid, _message text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _sender UUID := auth.uid();
  _msg TEXT := btrim(coalesce(_message, ''));
  _assigned UUID;
  _status TEXT;
  _count int := 0;
  _mode text;
BEGIN
  IF _sender IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF char_length(_msg) = 0 THEN
    RAISE EXCEPTION 'Reminder note is required';
  END IF;
  IF char_length(_msg) > 1000 THEN
    RAISE EXCEPTION 'Reminder note is too long (max 1000 characters)';
  END IF;

  -- Any authenticated user with a CRM role may send a reminder.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _sender
  ) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT assigned_to, cs_status::text INTO _assigned, _status
  FROM public.qualified_leads
  WHERE id = _lead_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found';
  END IF;

  -- Reminders are not allowed on processed leads.
  IF _status = 'converted' THEN
    RAISE EXCEPTION 'Cannot send a reminder on a processed lead';
  END IF;

  IF _assigned IS NOT NULL THEN
    -- Assigned CS user + every active cs_admin.
    WITH recipients AS (
      SELECT _assigned AS user_id
      UNION
      SELECT ur.user_id
      FROM public.user_roles ur
      WHERE ur.role::text = 'cs_admin'
    ),
    active AS (
      SELECT DISTINCT r.user_id
      FROM recipients r
      JOIN public.profiles p ON p.user_id = r.user_id
      WHERE p.is_active = true
    ),
    ins AS (
      INSERT INTO public.lead_reminders (lead_id, sender_user_id, recipient_user_id, message)
      SELECT _lead_id, _sender, a.user_id, _msg FROM active a
      RETURNING 1
    )
    SELECT count(*)::int INTO _count FROM ins;
    _mode := 'assigned';
  ELSE
    -- Unassigned lead: broadcast to all active CS users.
    WITH cs_users AS (
      SELECT DISTINCT ur.user_id
      FROM public.user_roles ur
      JOIN public.profiles p ON p.user_id = ur.user_id
      WHERE ur.role::text = 'cs'
        AND p.is_active = true
    ),
    ins AS (
      INSERT INTO public.lead_reminders (lead_id, sender_user_id, recipient_user_id, message)
      SELECT _lead_id, _sender, cu.user_id, _msg FROM cs_users cu
      RETURNING 1
    )
    SELECT count(*)::int INTO _count FROM ins;
    _mode := 'broadcast';
  END IF;

  IF _count = 0 THEN
    RAISE EXCEPTION 'No active CS users are available to receive this reminder';
  END IF;

  RETURN jsonb_build_object('mode', _mode, 'recipient_count', _count);
END;
$$;

REVOKE ALL ON FUNCTION public.send_lead_reminder(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_lead_reminder(uuid, text) TO authenticated;

-- ── 2. count_pending_reminder_leads ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.count_pending_reminder_leads()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role::text IN ('admin', 'sub_admin', 'cs', 'cs_admin')
    )
    THEN (
      SELECT count(DISTINCT lr.lead_id)::int
      FROM public.lead_reminders lr
      WHERE lr.is_read = false
    )
    ELSE 0
  END;
$$;

REVOKE ALL ON FUNCTION public.count_pending_reminder_leads() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_pending_reminder_leads() TO authenticated;

-- ── 3. list_pending_reminder_leads ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_pending_reminder_leads()
RETURNS TABLE (
  lead_id uuid,
  customer_name text,
  customer_number text,
  main_area text,
  sub_area text,
  cs_status text,
  assigned_to uuid,
  reminder_count bigint,
  last_reminder_at timestamptz,
  last_message text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ql.id,
    ql.customer_name,
    ql.customer_number,
    ql.main_area,
    ql.sub_area,
    ql.cs_status::text,
    ql.assigned_to,
    count(lr.id) AS reminder_count,
    max(lr.created_at) AS last_reminder_at,
    (array_agg(lr.message ORDER BY lr.created_at DESC))[1] AS last_message
  FROM public.lead_reminders lr
  JOIN public.qualified_leads ql ON ql.id = lr.lead_id
  WHERE lr.is_read = false
    AND EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role::text IN ('admin', 'sub_admin', 'cs', 'cs_admin')
    )
  GROUP BY ql.id
  ORDER BY max(lr.created_at) DESC;
$$;

REVOKE ALL ON FUNCTION public.list_pending_reminder_leads() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_pending_reminder_leads() TO authenticated;

-- ── 4. acknowledge_lead_reminders ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.acknowledge_lead_reminders(_lead_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _n int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role::text IN ('admin', 'sub_admin', 'cs', 'cs_admin')
  ) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  UPDATE public.lead_reminders
  SET is_read = true, read_at = now()
  WHERE lead_id = _lead_id AND is_read = false;

  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_lead_reminders(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acknowledge_lead_reminders(uuid) TO authenticated;
