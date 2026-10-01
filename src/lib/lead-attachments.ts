import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

const BUCKET = "lead-attachments";
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

// Given either a legacy public URL or a storage path, return the storage path.
export function toStoragePath(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Legacy public URL: /storage/v1/object/public/lead-attachments/<path>
  const publicMatch = trimmed.match(/\/storage\/v1\/object\/public\/lead-attachments\/(.+)$/);
  if (publicMatch) return decodeURI(publicMatch[1]);
  // Signed URL that already exists — strip host + query
  const signedMatch = trimmed.match(/\/storage\/v1\/object\/sign\/lead-attachments\/([^?]+)/);
  if (signedMatch) return decodeURI(signedMatch[1]);
  // Assume raw storage path
  return trimmed.replace(/^\/+/, "");
}

// Resolve an array of image references (public URLs or paths) into short-lived
// signed URLs. Falls back to the original string on error so the UI degrades
// gracefully instead of showing broken thumbnails.
export function useSignedLeadUrls(refs: readonly (string | null | undefined)[] | null | undefined) {
  const [urls, setUrls] = useState<string[]>([]);

  const key = (refs ?? []).map((r) => r ?? "").join("|");

  useEffect(() => {
    let cancelled = false;
    async function run() {
      const list = (refs ?? []).filter((v): v is string => Boolean(v));
      if (list.length === 0) {
        if (!cancelled) setUrls([]);
        return;
      }
      const paths = list.map((r) => toStoragePath(r)).filter((p): p is string => Boolean(p));
      if (paths.length === 0) {
        if (!cancelled) setUrls(list);
        return;
      }
      try {
        const { data, error } = await supabase.storage
          .from(BUCKET)
          .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
        if (error) throw error;
        const signed = (data ?? []).map((d, i) => d.signedUrl || list[i]);
        if (!cancelled) setUrls(signed);
      } catch {
        if (!cancelled) setUrls(list);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return urls;
}
