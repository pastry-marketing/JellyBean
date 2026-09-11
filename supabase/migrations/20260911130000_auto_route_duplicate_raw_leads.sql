-- Route duplicate raw leads straight to the "Duplicate" section.
--
-- Duplicate detection already happens at ingestion — a fresh row arrives with
-- duplicate_detected = true (see the Nextdoor webhook). Previously such a row
-- still landed in "New" (category NULL) and only moved to "Duplicate" when
-- someone clicked "Move duplicates → Duplicate". This BEFORE INSERT trigger
-- sets category = 'duplicate' for those rows as they are inserted, so they land
-- in the Duplicate section automatically.
--
-- Safety notes:
--   * INSERT-only. It never fires on UPDATE, so it can never overwrite a
--     category later set by a person or another process.
--   * Guarded on category IS NULL, so a row that already arrives with an
--     explicit category is left exactly as-is.
--   * No existing rows are touched (no backfill) — current behaviour for
--     already-stored leads is unchanged.
--   * 'duplicate' is already an allowed category value and is already handled
--     by the raw_lead_cache_counts trigger, so counters stay correct with no
--     extra work.

CREATE OR REPLACE FUNCTION public.tg_raw_lead_cache_route_duplicates()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.duplicate_detected IS TRUE AND NEW.category IS NULL THEN
    NEW.category := 'duplicate';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS raw_lead_cache_route_duplicates ON public.raw_lead_cache;
CREATE TRIGGER raw_lead_cache_route_duplicates
  BEFORE INSERT ON public.raw_lead_cache
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_raw_lead_cache_route_duplicates();
