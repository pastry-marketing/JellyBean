-- Service/Area Base
-- Admins & CS admins define, per submitter role group (FB / SEO / ND), which
-- service + state (+ optional city) combinations are acceptable, with an
-- optional activation window. Leads submitted outside the active base are
-- flagged out_of_base (a tag), and — per the role's enforcement mode — can
-- also be moved to the 'out_of_base' CS status.
--
-- Role groups:
--   fb  -> facebook
--   seo -> seo
--   nd  -> maturing, sub_admin

-- Tag column driving the "Out of Base" badge in the CS pipeline & forwarded leads.
ALTER TABLE public.qualified_leads
  ADD COLUMN IF NOT EXISTS out_of_base boolean NOT NULL DEFAULT false;

-- Base rules.
CREATE TABLE IF NOT EXISTS public.service_area_bases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_group text NOT NULL CHECK (role_group IN ('fb', 'seo', 'nd')),
  service_scope text NOT NULL CHECK (service_scope IN ('category', 'service')),
  service_value text NOT NULL,
  state_code text NOT NULL,
  city text,
  active_from date,
  active_to date,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_service_area_bases_role ON public.service_area_bases (role_group);

-- Per-role enforcement configuration.
--   warn   -> warn the submitter, add the lead, tag it Out of Base
--   status -> everything 'warn' does, plus set cs_status = 'out_of_base'
CREATE TABLE IF NOT EXISTS public.service_area_base_config (
  role_group text PRIMARY KEY CHECK (role_group IN ('fb', 'seo', 'nd')),
  enforcement_mode text NOT NULL DEFAULT 'warn' CHECK (enforcement_mode IN ('warn', 'status')),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.service_area_base_config (role_group)
VALUES ('fb'), ('seo'), ('nd')
ON CONFLICT (role_group) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.service_area_bases TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.service_area_base_config TO authenticated;

ALTER TABLE public.service_area_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_area_base_config ENABLE ROW LEVEL SECURITY;

-- Any CRM role-holder may READ the rules/config (submitters evaluate their own
-- group's rules client-side; the pipeline reads config to decide status visibility).
CREATE POLICY "service_area_bases: read"
  ON public.service_area_bases FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid()));

-- Only admin / cs_admin may create, edit, or delete rules.
CREATE POLICY "service_area_bases: write"
  ON public.service_area_bases FOR ALL TO authenticated
  USING (
    public.current_user_has_role_text('admin')
    OR public.current_user_has_role_text('cs_admin')
  )
  WITH CHECK (
    public.current_user_has_role_text('admin')
    OR public.current_user_has_role_text('cs_admin')
  );

CREATE POLICY "service_area_base_config: read"
  ON public.service_area_base_config FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid()));

CREATE POLICY "service_area_base_config: write"
  ON public.service_area_base_config FOR ALL TO authenticated
  USING (
    public.current_user_has_role_text('admin')
    OR public.current_user_has_role_text('cs_admin')
  )
  WITH CHECK (
    public.current_user_has_role_text('admin')
    OR public.current_user_has_role_text('cs_admin')
  );
