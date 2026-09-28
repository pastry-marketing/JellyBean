import { CacheEntry } from "./raw-leads.functions";
import { normalizePhone as sharedNormalizePhone } from "./crm-lite";

export type MatchType = "Exact Match" | "90% Similar";

export interface FrontendDuplicateMatch {
  matchedLeadId: string;
  matchedLead: CacheEntry;
  matchType: MatchType;
  similarityScore: number;
  reasons: string[];
}

// Single source of truth for phone normalization lives in crm-lite; re-exported
// so existing callers keep working.
export const normalizePhone = sharedNormalizePhone;

export function normalizeText(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
}

export function calculateTextSimilarity(text1: string, text2: string): number {
  if (!text1 || !text2) return 0;
  if (text1 === text2) return 1;
  const set1 = new Set(text1.split(" "));
  const set2 = new Set(text2.split(" "));
  if (set1.size === 0 && set2.size === 0) return 0;
  let intersectionSize = 0;
  for (const word of set1) {
    if (set2.has(word)) intersectionSize++;
  }
  const unionSize = set1.size + set2.size - intersectionSize;
  if (unionSize === 0) return 0;
  return intersectionSize / unionSize;
}

export function buildVisibleRawLeadDuplicateMap(
  shownRows: CacheEntry[],
): Record<string, FrontendDuplicateMatch[]> {
  const map: Record<string, FrontendDuplicateMatch[]> = {};

  if (!shownRows || shownRows.length === 0 || shownRows.length > 500) {
    return map;
  }

  for (let i = 0; i < shownRows.length; i++) {
    for (let j = i + 1; j < shownRows.length; j++) {
      const a = shownRows[i];
      const b = shownRows[j];

      // Safety skip
      if (a.row_key === b.row_key) continue;

      const match = checkMatch(a, b);
      if (match) {
        if (!map[a.row_key]) map[a.row_key] = [];
        if (!map[b.row_key]) map[b.row_key] = [];

        map[a.row_key].push({
          matchedLeadId: b.row_key,
          matchedLead: b,
          matchType: match.type,
          similarityScore: match.score,
          reasons: [...match.reasons],
        });

        map[b.row_key].push({
          matchedLeadId: a.row_key,
          matchedLead: a,
          matchType: match.type,
          similarityScore: match.score,
          reasons: [...match.reasons],
        });
      }
    }
  }

  return map;
}

function checkMatch(
  a: CacheEntry,
  b: CacheEntry,
): { type: MatchType; score: number; reasons: string[] } | null {
  const reasons: string[] = [];
  let isExact = false;

  const phoneA = normalizePhone(a.phone);
  const phoneB = normalizePhone(b.phone);
  if (phoneA && phoneB && phoneA === phoneB) {
    isExact = true;
    reasons.push("Matched phone number");
  }

  const linkA = a.data["Lead Link"]?.trim();
  const linkB = b.data["Lead Link"]?.trim();
  if (linkA && linkB && linkA === linkB) {
    isExact = true;
    reasons.push("Matched post link");
  }

  if (a.row_key && b.row_key && a.row_key === b.row_key) {
    isExact = true;
    reasons.push("Matched row key");
  }

  const textA = normalizeText(a.data["Post Text"]);
  const textB = normalizeText(b.data["Post Text"]);
  let textSimilarity = 0;

  // Only consider text similarity if long enough
  if (textA.length > 50 && textB.length > 50) {
    if (textA === textB) {
      isExact = true;
      reasons.push("Exact lead text match");
      textSimilarity = 1;
    } else {
      textSimilarity = calculateTextSimilarity(textA, textB);
    }
  }

  const nameA = normalizeText(a.data["Account Name"]);
  const nameB = normalizeText(b.data["Account Name"]);
  if (nameA && nameB && nameA === nameB && nameA.length > 3) {
    // If we have same phone and same account name -> exact match
    if (phoneA && phoneB && phoneA === phoneB) {
      isExact = true;
    }
    reasons.push("Same account/name");
  }

  const serviceA = normalizeText(a.data["Service / Category"]);
  const serviceB = normalizeText(b.data["Service / Category"]);
  if (serviceA && serviceB && serviceA === serviceB) {
    reasons.push("Same service/category");
  }

  if (isExact) {
    return { type: "Exact Match", score: 100, reasons };
  }

  // 90% Similar rules
  if (textSimilarity >= 0.9) {
    reasons.push(`Lead text highly similar (${Math.round(textSimilarity * 100)}%)`);
    return { type: "90% Similar", score: Math.round(textSimilarity * 100), reasons };
  }

  if (textSimilarity >= 0.85 && (nameA === nameB || serviceA === serviceB)) {
    reasons.push(
      `Lead text strongly similar with supporting signal (${Math.round(textSimilarity * 100)}%)`,
    );
    return { type: "90% Similar", score: Math.round(textSimilarity * 100), reasons };
  }

  return null;
}
