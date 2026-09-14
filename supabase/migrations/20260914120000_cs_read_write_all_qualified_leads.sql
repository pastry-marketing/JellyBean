-- Give the `cs` role full visibility and edit access to every qualified lead.
--
-- Before this change the read/update policies scoped `cs` to leads that were
-- assigned to the caller OR unassigned:
--     current_user_has_role('cs') AND (assigned_to = auth.uid() OR assigned_to IS NULL)
-- so any lead assigned to another CS user was filtered out entirely. In the CS
-- pipeline this made every visible lead appear "Unassigned" (the rows with a
-- real assignee were simply hidden), while admin / cs_admin — which have a
-- read-all clause — saw assignees correctly.
--
-- Assignment is informational, not a lock: CS users should see who each lead is
-- assigned to and be able to work any lead. This aligns the `cs` clause with the
-- cs_admin/admin read-all behaviour for both SELECT and UPDATE. INSERT and DELETE
-- are intentionally left unchanged (CS still cannot delete other users' leads).
--
-- The `(SELECT ...)` wrapping around the role helpers matches the statement-level
-- caching introduced in 20260829120100_optimize_hot_rls_policies.sql.

ALTER POLICY "qualified_leads: read"
ON public.qualified_leads
USING (
  (SELECT public.current_user_has_role('admin'::public.app_role))
  OR (SELECT public.current_user_has_role_text('sub_admin'))
  OR (SELECT public.current_user_has_role_text('cs_admin'))
  OR (SELECT public.current_user_has_role('cs'::public.app_role))
  OR created_by = (SELECT auth.uid())
);

ALTER POLICY "qualified_leads: update"
ON public.qualified_leads
USING (
  (SELECT public.current_user_has_role('admin'::public.app_role))
  OR (SELECT public.current_user_has_role_text('sub_admin'))
  OR (SELECT public.current_user_has_role_text('cs_admin'))
  OR (SELECT public.current_user_has_role('cs'::public.app_role))
  OR (
    created_by = (SELECT auth.uid())
    AND cs_status = 'new'::public.cs_status
  )
)
WITH CHECK (
  (SELECT public.current_user_has_role('admin'::public.app_role))
  OR (SELECT public.current_user_has_role_text('sub_admin'))
  OR (SELECT public.current_user_has_role_text('cs_admin'))
  OR (SELECT public.current_user_has_role('cs'::public.app_role))
  OR (
    created_by = (SELECT auth.uid())
    AND cs_status = 'new'::public.cs_status
  )
);
