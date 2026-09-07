-- Migration: RPC Function and Policy for Google Sheets Sync Configuration
-- Allows users to persist the Google Sheets Webhook URL and Auto-Sync setting to shared_state without RLS errors.

-- 1. Create SECURITY DEFINER function to upsert google_sheets_sync_config into shared_state
CREATE OR REPLACE FUNCTION public.save_google_sheets_config(
  p_webhook_url TEXT,
  p_auto_sync BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.shared_state (key, value, updated_at)
  VALUES (
    'google_sheets_sync_config',
    jsonb_build_object(
      'webhookUrl', TRIM(p_webhook_url),
      'autoSync', COALESCE(p_auto_sync, TRUE),
      'updated_at', NOW()
    ),
    NOW()
  )
  ON CONFLICT (key) DO UPDATE
  SET
    value = EXCLUDED.value,
    updated_at = NOW();

  RETURN jsonb_build_object('success', true, 'webhookUrl', TRIM(p_webhook_url));
END;
$$;

-- Grant execution to authenticated and anon users
GRANT EXECUTE ON FUNCTION public.save_google_sheets_config(TEXT, BOOLEAN) TO authenticated, anon;

-- 2. Allow authenticated users to direct-write google_sheets_sync_config row in shared_state
DROP POLICY IF EXISTS "shared_state: google sheets sync config write" ON public.shared_state;
CREATE POLICY "shared_state: google sheets sync config write"
ON public.shared_state FOR ALL TO authenticated
USING (key = 'google_sheets_sync_config')
WITH CHECK (key = 'google_sheets_sync_config');
