// Canonical 50 states + DC. Used by the Lead Assignment UI.
export const US_STATES: { code: string; name: string }[] = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "DC", name: "District of Columbia" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" },
  { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" },
  { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" },
];

export const US_STATE_NAME: Record<string, string> = Object.fromEntries(
  US_STATES.map((s) => [s.code, s.name]),
);

const US_STATE_BY_NAME = new Map(US_STATES.map((state) => [state.name.toLowerCase(), state.code]));
const US_STATE_CODES = new Set(US_STATES.map((state) => state.code));

/** Resolve a complete state name or two-letter abbreviation to its canonical code. */
export function resolveUsStateCode(value: string): string | null {
  const normalized = value.trim().replace(/[.,]+$/, "");
  if (!normalized) return null;

  const upper = normalized.toUpperCase();
  if (US_STATE_CODES.has(upper)) return upper;
  return US_STATE_BY_NAME.get(normalized.toLowerCase()) ?? null;
}

/**
 * Detect a state at the end of an area such as "Austin, Texas", "Austin, TX",
 * or "Austin TX". Limiting detection to the suffix avoids matching state names
 * that happen to appear inside a neighborhood or street name.
 */
export function extractUsStateCodeFromArea(area: string): string | null {
  const trimmed = area.trim().replace(/[.,]+$/, "");
  if (!trimmed) return null;

  const statesByLongestName = [...US_STATES].sort((a, b) => b.name.length - a.name.length);
  const lower = trimmed.toLowerCase();
  for (const state of statesByLongestName) {
    const name = state.name.toLowerCase();
    if (lower === name || lower.endsWith(` ${name}`) || lower.endsWith(`,${name}`)) {
      return state.code;
    }
  }

  const abbreviationMatch = trimmed.match(/(?:^|[-,/|\s])([A-Za-z]{2})$/);
  if (!abbreviationMatch) return null;

  const candidate = abbreviationMatch[1];
  const hasExplicitSeparator = /[-,/|]\s*[A-Za-z]{2}$/.test(trimmed);
  if (!hasExplicitSeparator && candidate !== candidate.toUpperCase()) return null;
  return resolveUsStateCode(candidate);
}
