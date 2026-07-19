// parsers.js
// Converts raw CSV text from each source into a common shape:
//   { date: 'YYYY-MM-DD', desc: string, amount: number (signed, +in/-out), source: 'ING'|'AMEX'|'YNAB' }

// ---------- tiny CSV reader (handles quoted fields incl. embedded newlines) ----------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  // normalize line endings but keep \n inside quotes intact (we scan char by char so it's fine either way)
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field); field = "";
      } else if (c === "\r") {
        // skip, \n will terminate the row
      } else if (c === "\n") {
        row.push(field); field = "";
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

function rowsToObjects(rows) {
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
    return o;
  });
}

// DD/MM/YYYY -> YYYY-MM-DD
function ddmmyyyyToIso(s) {
  const [d, m, y] = s.split("/");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function moneyToNumber(s) {
  if (!s) return 0;
  return parseFloat(s.replace(/[$,]/g, "")) || 0;
}

// ---------- ING bank export ----------
// Columns: Date,Description,Credit,Debit,Balance
function parseING(text) {
  const objs = rowsToObjects(parseCSV(text));
  return objs
    .filter(o => o.Date && (o.Credit || o.Debit))
    .map(o => {
      const credit = moneyToNumber(o.Credit);
      const debit = moneyToNumber(o.Debit); // already negative in source
      return {
        date: ddmmyyyyToIso(o.Date),
        desc: o.Description.trim(),
        amount: round2(credit + debit),
        source: "ING"
      };
    });
}

// ---------- AMEX export ----------
// Two variants seen:
//   simple:   Date,Date Processed,Description,Card Member,Account #,Amount
//   extended: same + Foreign Spend Amount,Commission,Exchange Rate,Additional Information,
//             Appears On Your Statement As,Address,Town/City,Postcode,Country,Reference
// Sign convention is OPPOSITE of ING: positive = charge (money out), negative = payment/credit (money in).
// Multiple AMEX exports often overlap (rolling "recent activity" downloads), so dedup by (date, desc, amount).
function parseAMEX(textsArray) {
  const seen = new Set();
  const out = [];
  for (const text of textsArray) {
    const objs = rowsToObjects(parseCSV(text));
    for (const o of objs) {
      if (!o.Date || o.Amount === undefined || o.Amount === "") continue;
      const rawAmount = moneyToNumber(o.Amount);
      const isoDate = ddmmyyyyToIso(o.Date);
      const desc = o.Description.trim();
      const key = `${isoDate}|${desc}|${rawAmount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        date: isoDate,
        desc,
        amount: round2(-rawAmount), // flip sign to match ING convention (+in / -out)
        source: "AMEX"
      });
    }
  }
  return out;
}

// ---------- NAB credit card export ----------
// Columns: Date,Amount,Account Number,,Transaction Type,Transaction Details,Balance,Category,Merchant Name,Processed On
// Date format: "12 Jul 26" (D MMM YY)
// Sign convention: same as ING — negative = money out (spend), positive = payment/credit in.
// The "Merchant Name" column is already clean (e.g. "Cafe Mellow Fellow", "Uber Eats")
// so we use it as the primary desc, falling back to "Transaction Details" if blank.
// Multiple exports may overlap, so dedup by (date, amount, transactionDetails).
function parseNAB(textsArray) {
  const MONTHS = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };

  function nabDateToIso(s) {
    // "12 Jul 26" -> "2026-07-12"
    const [d, mon, yy] = s.trim().split(" ");
    const year = 2000 + parseInt(yy, 10);
    const month = String(MONTHS[mon] || 1).padStart(2, "0");
    return `${year}-${month}-${d.padStart(2, "0")}`;
  }

  const seen = new Set();
  const out = [];
  for (const text of textsArray) {
    const objs = rowsToObjects(parseCSV(text));
    for (const o of objs) {
      if (!o.Date || !o.Amount) continue;
      const amount = moneyToNumber(o.Amount);
      if (amount === 0) continue; // skip $0 rows
      const isoDate = nabDateToIso(o.Date);
      const txDetails = (o["Transaction Details"] || "").trim();
      const merchantName = (o["Merchant Name"] || "").trim();
      const txType = (o["Transaction Type"] || "").trim();
      const balance = (o["Balance"] || "").trim(); // unique per transaction even for identical charges
      const desc = merchantName || txDetails || txType;
      // include balance in dedup key so two genuine same-merchant/same-amount/same-day
      // purchases (e.g. buying the same thing twice) aren't incorrectly collapsed into one
      const key = `${isoDate}|${amount}|${txDetails}|${balance}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        date: isoDate,
        desc,
        rawDesc: txDetails, // keep raw for dedup across overlapping exports
        amount: round2(amount), // already signed correctly: negative = spend
        source: "NAB"
      });
    }
  }
  return out;
}


// Columns: Account,Flag,Date,Payee,Category Group/Category,Category Group,Category,Memo,Outflow,Inflow,Cleared
function parseYNAB(text) {
  const objs = rowsToObjects(parseCSV(text));
  return objs
    .filter(o => o.Date)
    .map(o => {
      const out = moneyToNumber(o.Outflow);
      const inn = moneyToNumber(o.Inflow);
      return {
        date: ddmmyyyyToIso(o.Date),
        payee: o.Payee || "",
        memo: o.Memo || "",
        categoryGroup: o["Category Group"] || "",
        category: o["Category"] || "",
        amount: round2(inn - out),
        account: o.Account || "",
        source: "YNAB"
      };
    });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
