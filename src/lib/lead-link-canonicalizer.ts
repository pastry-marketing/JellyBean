export function extractNextdoorPostId(url: string | null | undefined): string | null {
  if (!url) return null;
  // Match nextdoor.com/p/{postId}
  const match = url.match(/(?:nextdoor\.com.*?\/p\/)([\w-]+)/i);
  if (match && match[1]) {
    return match[1];
  }
  return null;
}

export function canonicalizeLeadLink(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    // Return just origin and pathname, removing query params and hash
    let canonical = `${parsed.origin}${parsed.pathname}`;
    // Remove trailing slash for consistency
    if (canonical.endsWith("/")) {
      canonical = canonical.slice(0, -1);
    }
    return canonical;
  } catch (err) {
    // If it's not a valid URL, return the original string trimmed
    return url.trim();
  }
}

export function normalizeLeadText(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "") // Remove punctuation
    .replace(/\s+/g, " "); // Collapse whitespace
}

export function normalizeName(text: string | null | undefined): string {
  return normalizeLeadText(text);
}

export function normalizeNeighborhood(text: string | null | undefined): string {
  return normalizeLeadText(text);
}
