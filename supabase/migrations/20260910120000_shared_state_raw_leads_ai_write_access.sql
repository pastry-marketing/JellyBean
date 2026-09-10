-- Fix: the Raw Leads "auto-continue" AI checker toggle silently unticks for
-- sub_admin / maturing / acc_handler users.
--
-- The Raw Leads page (RoleGate) is open to: admin, sub_admin, scraping,
-- maturing and acc_handler. Its AI auto-checker persists two flags in
-- public.shared_state:
--   * raw_leads_auto_continue_enabled  -- the continuous-check toggle
--   * raw_leads.ai_lock                -- cross-user "AI is running" lock
--
-- But shared_state's INSERT/UPDATE policies only allow admin and scraping
-- (the value formerly named 'marketing', later renamed in-place to 'scraping').
-- So for sub_admin / maturing / acc_handler users the upsert is rejected by RLS:
-- the client optimistically ticks the box, the write fails, and the follow-up
-- refetch reverts it -- i.e. the toggle "auto-unticks".
--
-- Grant those Raw Leads roles write access, scoped to just these two keys so no
-- other shared_state values are exposed. PostgreSQL ORs multiple permissive
-- policies together, so the existing admin/scraping policies keep working.

DROP POLICY IF EXISTS "shared_state: raw-leads ai keys insert" ON public.shared_state;
CREATE POLICY "shared_state: raw-leads ai keys insert"
  ON public.shared_state FOR INSERT TO authenticated
  WITH CHECK (
    key IN ('raw_leads_auto_continue_enabled', 'raw_leads.ai_lock')
    AND (
      public.current_user_has_role_text('admin')
      OR public.current_user_has_role_text('sub_admin')
      OR public.current_user_has_role_text('scraping')
      OR public.current_user_has_role_text('maturing')
      OR public.current_user_has_role_text('acc_handler')
    )
  );

DROP POLICY IF EXISTS "shared_state: raw-leads ai keys update" ON public.shared_state;
CREATE POLICY "shared_state: raw-leads ai keys update"
  ON public.shared_state FOR UPDATE TO authenticated
  USING (
    key IN ('raw_leads_auto_continue_enabled', 'raw_leads.ai_lock')
    AND (
      public.current_user_has_role_text('admin')
      OR public.current_user_has_role_text('sub_admin')
      OR public.current_user_has_role_text('scraping')
      OR public.current_user_has_role_text('maturing')
      OR public.current_user_has_role_text('acc_handler')
    )
  )
  WITH CHECK (
    key IN ('raw_leads_auto_continue_enabled', 'raw_leads.ai_lock')
    AND (
      public.current_user_has_role_text('admin')
      OR public.current_user_has_role_text('sub_admin')
      OR public.current_user_has_role_text('scraping')
      OR public.current_user_has_role_text('maturing')
      OR public.current_user_has_role_text('acc_handler')
    )
  );
