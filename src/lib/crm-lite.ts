export function normalizePhone(value: string | null | undefined): string {
  const digits = (value ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

export function formatPhone(value: string | null | undefined): string {
  const digits = normalizePhone(value);
  if (digits.length !== 10) return value?.trim() ?? "";
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/**
 * Build a separator-agnostic ILIKE pattern for phone search.
 *
 * Phone numbers are stored in mixed formats — "(555) 123-4567", "5551234567",
 * "+1 555 123 4567" — because different insert paths format them differently.
 * A literal ILIKE of the typed value therefore misses most rows whenever the
 * search text and the stored text use different separators. Spreading the
 * query's digits with "%" between each makes the digit sequence match no matter
 * what separators surround or sit between them.
 *
 * Returns null when the term has too few digits to be a meaningful phone
 * search, so callers can fall back to a normal text ILIKE.
 */
export function phoneSearchPattern(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  if (digits.length < 3) return null;
  return `%${digits.split("").join("%")}%`;
}

/**
 * True when `term`'s digits appear contiguously within `value`'s digits.
 * Used to tighten client-side filtering so "5551234567" matches a stored
 * "(555) 123-4567" (and vice versa) while ignoring formatting on both sides.
 */
export function phoneDigitsMatch(value: string | null | undefined, term: string): boolean {
  const needle = term.replace(/\D/g, "");
  if (!needle) return false;
  return (value ?? "").replace(/\D/g, "").includes(needle);
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function downloadCsv(filename: string, headers: string[], rows: unknown[][]) {
  // Prepend UTF-8 BOM so Excel opens non-ASCII characters correctly.
  const csv = "\ufeff" + [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
