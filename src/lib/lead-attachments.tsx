import { useSignedLeadUrls } from "@/lib/lead-attachments";

// Small helper: signs a single image ref (legacy public URL OR storage path) and
// renders an <img>. Falls back to the raw ref on error.
export function SignedLeadImage({
  refValue,
  alt = "",
  className,
  fallback,
}: {
  refValue: string | null | undefined;
  alt?: string;
  className?: string;
  fallback?: React.ReactNode;
}) {
  const urls = useSignedLeadUrls(refValue ? [refValue] : []);
  const src = urls[0];
  if (!refValue || !src) return <>{fallback ?? null}</>;
  return <img src={src} alt={alt} className={className} loading="lazy" />;
}
