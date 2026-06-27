# Reconciler

Finds bank transactions that haven't made it into YNAB yet, and syncs the
missing ones across via the YNAB API — with a review step before anything
gets written.

## Setup

1. Open `index.html` (once deployed to GitHub Pages, just visit the URL).
2. Paste your YNAB Personal Access Token and click **Connect**.
   - Get one from YNAB → Account Settings → Developer Settings → New Token.
   - It's stored only in this browser's `localStorage` — never sent anywhere
     except directly to YNAB's API.
3. **Personal mode**: pick your personal budget, then the account your ING
   statement should post to.
4. **Business mode**: pick the Bodega budget, then which YNAB account is the
   Bodega ING account and which is the AMEX account. The matcher uses this to
   route each found transaction to the right place automatically.

These selections are remembered, so this is a one-time setup per browser.

## Weekly use (Personal mode)

1. Export your ING statement as CSV for the period you want to check.
2. Export your YNAB transactions as CSV for the same period (YNAB → Account
   → ⋮ → Export).
3. Upload both, click **Find discrepancies**.
4. Review the list — payee and category are pre-filled based on your past
   YNAB history (merchants you've seen before get a "matched history" badge;
   new ones get a plain cleaned-up guess you should check).
5. Untick anything you don't want to sync, edit any field inline, then
   **Sync selected to YNAB**.

## Business mode (Bodega)

Same flow, but:
- Upload the **Bodega ING CSV** in the bank slot.
- Upload **AMEX CSV(s)** in the AMEX slot — you can select multiple files at
  once. If your AMEX exports overlap (e.g. you downloaded "recent activity"
  a few times and they cover some of the same dates), the app automatically
  removes duplicates by matching date + description + amount, so it's safe
  to just throw all your AMEX exports in together.

### First-time backlog catch-up

Since Bodega hasn't been reconciled since ~January 2026, the first run will
surface a large number of missing transactions, not just a week's worth.
Recommended approach:

- Do it in monthly batches rather than all 6+ months at once — easier to
  sanity-check the review table, and YNAB's API allows 200 requests/hour,
  so very large single syncs need pacing anyway.
- For each batch: upload the ING/AMEX rows for that month plus your current
  full YNAB export for the Bodega budget (so the matcher knows what's
  already there), review, sync, then move to the next month.
- Category guessing will be weak for the *first* batch (little history to
  learn from) and improve automatically as you go, since each sync pulls
  fresh transaction history from YNAB before guessing.

## How matching works

A bank/AMEX transaction counts as "already in YNAB" if there's a YNAB entry
with the **same amount** (to the cent) within **5 days** of its date — banks
typically post a transaction 1-2 days after it happens, occasionally longer,
so exact-day matching isn't used. When several transactions of the same
recurring amount exist in a short window (e.g. three $5.80 coffees in a
month), the matcher pairs the closest dates first across the whole batch
rather than greedily grabbing the nearest match one at a time — this avoids
mismatches that can otherwise cascade and produce false "missing" results.

Anything left unmatched on the bank/AMEX side is shown for review. Nothing
on the YNAB side being unmatched is currently surfaced (i.e. this tool finds
"things you forgot to enter," not "things you entered that aren't in your
bank" — extend `matcher.js` if you also want that direction checked).

## Duplicate-safety

Every transaction created via sync gets a deterministic `import_id`
(`RECON:<amount-in-milliunits>:<date>:<occurrence>`). If you accidentally
sync the same batch twice, YNAB will recognise the duplicate `import_id` and
skip recreating it rather than double-entering — this is reported in the
sync log as "Skipped as duplicates."

## File formats supported

- **ING**: `Date,Description,Credit,Debit,Balance`
- **AMEX**: both the simple 6-column export and the extended export with
  foreign-exchange/address columns. Sign convention is auto-flipped (AMEX:
  positive = charge; this app's internal convention, matching ING: negative
  = money out) so both sources compare correctly against YNAB.
- **YNAB**: standard "Export all transactions as TSV/CSV" download format.

## Known limitations / things to keep an eye on

- The category/payee guess is just a best-effort suggestion from your own
  history — always check it before syncing, especially for new merchants.
- Refunds and split transactions aren't specially handled; review those
  rows carefully if they show up.
- This only checks one direction (bank → YNAB gaps). It won't catch a YNAB
  entry that's wrong but still "matched" by amount/date to a real bank
  transaction (e.g. wrong category on something that did get entered).
