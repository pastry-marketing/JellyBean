-- Persist the priority buckets used by the Browser Profiles workspace.
ALTER TABLE public.incogniton_profiles
  ADD COLUMN IF NOT EXISTS profile_priority text NOT NULL DEFAULT 'none';

ALTER TABLE public.incogniton_profiles
  DROP CONSTRAINT IF EXISTS incogniton_profiles_profile_priority_check;

ALTER TABLE public.incogniton_profiles
  ADD CONSTRAINT incogniton_profiles_profile_priority_check
  CHECK (profile_priority IN ('none', 'first', 'second'));

CREATE INDEX IF NOT EXISTS idx_incogniton_profiles_priority
  ON public.incogniton_profiles (profile_priority);
