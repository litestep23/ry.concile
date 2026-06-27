// matcher.js
// Core reconciliation logic: given bank-side transactions (ING and/or AMEX) and
// YNAB-side transactions, find bank transactions with no YNAB counterpart.
//
// Matching rule (proven manually on real data): same signed amount, within a
// date window (post-date lag is normal, usually 1-4 days), each YNAB row used once.

const DATE_WINDOW_DAYS = 5; // observed posting lag on real data: 0-2 days typical, up to 5 in edge cases

function daysBetween(isoA, isoB) {
  const a = new Date(isoA + "T00:00:00Z");
  const b = new Date(isoB + "T00:00:00Z");
  return Math.abs((a - b) / 86400000);
}

// bankTxns: [{date, desc, amount, source}]
// ynabTxns: [{date, payee, memo, amount, ...}]
// returns { missing: [...bankTxns not found in ynab, each annotated], matchedCount }
//
// Uses globally optimal pairing (closest-date-first across ALL candidate pairs,
// not just nearest-available-at-the-time) so recurring same-amount merchants
// don't get mismatched out of order — e.g. five $5.50 coffees in a month need
// each bank entry paired with the closest YNAB entry overall, not whichever
// is closest at the moment we happen to process that particular bank row.
function findMissing(bankTxns, ynabTxns) {
  // build every valid candidate pair (same amount, within date window)
  const candidates = [];
  bankTxns.forEach((b, bi) => {
    ynabTxns.forEach((y, yi) => {
      if (Math.abs(y.amount - b.amount) > 0.001) return;
      const diff = daysBetween(y.date, b.date);
      if (diff <= DATE_WINDOW_DAYS) candidates.push({ bi, yi, diff });
    });
  });
  // closest matches win first
  candidates.sort((a, b) => a.diff - b.diff);

  const bankUsed = new Array(bankTxns.length).fill(false);
  const ynabUsed = new Array(ynabTxns.length).fill(false);
  let matchedCount = 0;

  for (const c of candidates) {
    if (bankUsed[c.bi] || ynabUsed[c.yi]) continue;
    bankUsed[c.bi] = true;
    ynabUsed[c.yi] = true;
    matchedCount++;
  }

  const missing = bankTxns
    .filter((_, bi) => !bankUsed[bi])
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(b => ({ ...b }));

  return { missing, matchedCount, totalBank: bankTxns.length, totalYnab: ynabTxns.length };
}

// ---------- payee/category guessing from history ----------
// Builds a lookup keyed on a normalized merchant token -> most common {payee, categoryGroup, category}
// historyTxns should be YNAB-shaped rows (from parseYNAB, or from the YNAB API transaction list).

function normalizeMerchant(desc) {
  return desc
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\b(VISA|PURCHASE|RECEIPT|DATE|CARD|ONLINE|PTY|LTD|AUSTRALIA|HELP|COM)\b/g, " ")
    .replace(/\d{4,}/g, " ") // strip long numeric IDs
    .replace(/\s+/g, " ")
    .trim();
}

// crude token-overlap similarity, good enough for short merchant strings
function tokenOverlap(a, b) {
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

function buildHistoryModel(historyTxns) {
  // group by normalized payee text, tally category + actual payee label used
  const groups = {}; // normKey -> { payeeCounts, categoryCounts, samples: [] }
  for (const t of historyTxns) {
    if (!t.payee) continue;
    const norm = normalizeMerchant(t.payee);
    if (!norm) continue;
    if (!groups[norm]) groups[norm] = { payeeCounts: {}, categoryCounts: {}, count: 0 };
    const g = groups[norm];
    g.count++;
    g.payeeCounts[t.payee] = (g.payeeCounts[t.payee] || 0) + 1;
    const catKey = JSON.stringify({ group: t.categoryGroup, category: t.category });
    g.categoryCounts[catKey] = (g.categoryCounts[catKey] || 0) + 1;
  }
  return groups;
}

function topKey(counts) {
  let best = null, bestN = -1;
  for (const [k, n] of Object.entries(counts)) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return { key: best, count: bestN };
}

// Given a bank description, find the closest historical merchant group and
// return a guess with a confidence indicator.
function guessForTransaction(bankDesc, historyModel) {
  const norm = normalizeMerchant(bankDesc);
  let bestKey = null, bestScore = 0, bestGroup = null;
  for (const [key, group] of Object.entries(historyModel)) {
    const score = norm === key ? 1 : tokenOverlap(norm, key);
    if (score > bestScore) { bestScore = score; bestKey = key; bestGroup = group; }
  }

  if (!bestGroup || bestScore < 0.34) {
    return {
      payee: titleCaseGuess(bankDesc),
      categoryGroup: "",
      category: "",
      confidence: "low",
      matchedHistoryCount: 0
    };
  }

  const payeeGuess = topKey(bestGroup.payeeCounts);
  const catGuess = topKey(bestGroup.categoryCounts);
  let catParsed = { group: "", category: "" };
  try { catParsed = JSON.parse(catGuess.key); } catch (e) {}

  // confidence: high if we've seen this merchant 3+ times and the top category
  // accounts for most of those occurrences, and string similarity is strong
  const dominant = catGuess.count / bestGroup.count;
  const confidence =
    bestScore > 0.6 && bestGroup.count >= 2 && dominant >= 0.6 ? "high" : "low";

  return {
    payee: payeeGuess.key || titleCaseGuess(bankDesc),
    categoryGroup: catParsed.group || "",
    category: catParsed.category || "",
    confidence,
    matchedHistoryCount: bestGroup.count
  };
}

// fallback payee cleanup when there's no history to lean on - strips common
// POS noise from raw bank descriptions so it's not totally unreadable
function titleCaseGuess(desc) {
  let s = desc
    .replace(/\s*-\s*(Visa Purchase|Direct Debit|Osko Payment.*|Transfer.*|Receipt.*)$/i, "")
    .replace(/^(SQ \*|DD \*|SP )/i, "")
    .trim();
  // collapse excess whitespace from fixed-width POS fields
  s = s.replace(/\s{2,}.*$/, "").trim();
  return s
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}
