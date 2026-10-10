-- Move the out-of-base enforcement action from per-role to per-rule, so each
-- base rule can be edited independently between:
--   warn   -> warn the submitter, add the lead, tag it Out of Base
--   status -> everything 'warn' does, plus set cs_status = 'out_of_base'
ALTER TABLE public.service_area_bases
  ADD COLUMN IF NOT EXISTS enforcement_mode text NOT NULL DEFAULT 'warn'
  CHECK (enforcement_mode IN ('warn', 'status'));

-- The per-role config table is no longer used.
DROP TABLE IF EXISTS public.service_area_base_config;
