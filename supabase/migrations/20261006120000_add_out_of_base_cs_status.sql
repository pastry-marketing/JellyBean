-- New CS status for the Service/Area Base feature. Leads submitted outside an
-- active base can be moved to this status (per-role "warn + set status" mode).
-- Added in its own migration because Postgres cannot use a freshly added enum
-- value in the same transaction that adds it.
ALTER TYPE public.cs_status ADD VALUE IF NOT EXISTS 'out_of_base';
