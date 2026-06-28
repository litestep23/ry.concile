// app.js
// Wires together: mode switching, YNAB connect/budget selection, file uploads,
// running the matcher, rendering the review table, and syncing confirmed rows.

const state = {
  mode: "personal", // 'personal' | 'business'
  token: null,
  budgets: [],
  personal: { budgetId: null, accountId: null, accounts: [], categories: [] },
  business: { budgetId: null, accountIdING: null, accountIdAMEX: null, accounts: [], categories: [] },
  historyModel: null,
  lastMatchResult: null, // array of review rows
};

const el = id => document.getElementById(id);

// ---------- persistence ----------
function saveLocal() {
  const toSave = {
    token: state.token,
    personal: { budgetId: state.personal.budgetId, accountId: state.personal.accountId },
    business: {
      budgetId: state.business.budgetId,
      accountIdING: state.business.accountIdING,
      accountIdAMEX: state.business.accountIdAMEX
    }
  };
  localStorage.setItem("reconciler_settings", JSON.stringify(toSave));
}

function loadLocal() {
  try {
    const raw = localStorage.getItem("reconciler_settings");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

// ---------- mode toggle ----------
el("btnPersonal").addEventListener("click", () => setMode("personal"));
el("btnBusiness").addEventListener("click", () => setMode("business"));

function setMode(mode) {
  state.mode = mode;
  el("btnPersonal").classList.toggle("active", mode === "personal");
  el("btnBusiness").classList.toggle("active", mode === "business");
  el("modeLabel").textContent = mode === "personal"
    ? "personal · bank → ynab"
    : "business · bodega · ing + amex → ynab";

  el("personalBudgetRow").classList.toggle("hidden", mode !== "personal");
  el("businessBudgetRow").classList.toggle("hidden", mode !== "business");
  el("amexRow").classList.toggle("hidden", mode !== "business");
  el("bankLabel").textContent = mode === "personal"
    ? "Bank statement (ING CSV)"
    : "Bodega ING statement (CSV)";
  el("bankOptionalHint").textContent = mode === "business"
    ? "Optional — leave blank if you're only reconciling AMEX right now."
    : "";

  resetResults();
  refreshUploadReady();
}

// ---------- connect ----------
el("btnConnect").addEventListener("click", connect);

async function connect() {
  const tokenVal = el("tokenInput").value.trim();
  if (!tokenVal) return;
  state.token = tokenVal;
  YnabClient.setToken(tokenVal);
  setStatus("connectStatus", "Connecting…", "");

  try {
    const budgets = await YnabClient.listBudgets();
    state.budgets = budgets;
    populateBudgetSelects(budgets);
    el("budgetPickers").classList.remove("hidden");
    setStatus("connectStatus", `Connected — found ${budgets.length} budget(s).`, "ok");
    saveLocal();
  } catch (e) {
    setStatus("connectStatus", e.message, "error");
  }
}

function populateBudgetSelects(budgets) {
  const opts = budgets.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join("");
  el("personalBudgetSelect").innerHTML = `<option value="">Choose…</option>${opts}`;
  el("businessBudgetSelect").innerHTML = `<option value="">Choose…</option>${opts}`;

  // preselect business budget id we already know (Bodega)
  const saved = loadLocal();
  if (saved?.business?.budgetId) {
    el("businessBudgetSelect").value = saved.business.budgetId;
  }
  if (saved?.personal?.budgetId) {
    el("personalBudgetSelect").value = saved.personal.budgetId;
  }

  el("personalBudgetSelect").addEventListener("change", onPersonalBudgetChange);
  el("businessBudgetSelect").addEventListener("change", onBusinessBudgetChange);

  if (saved?.personal?.budgetId) onPersonalBudgetChange();
  if (saved?.business?.budgetId) onBusinessBudgetChange();
}

async function onPersonalBudgetChange() {
  const budgetId = el("personalBudgetSelect").value;
  state.personal.budgetId = budgetId;
  if (!budgetId) return;
  saveLocal();
  try {
    const accounts = await YnabClient.listAccounts(budgetId);
    state.personal.accounts = accounts;
    const opts = accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("");
    el("personalAccountSelect").innerHTML = `<option value="">Choose…</option>${opts}`;
    const saved = loadLocal();
    if (saved?.personal?.accountId) el("personalAccountSelect").value = saved.personal.accountId;
    el("personalAccountSelect").addEventListener("change", () => {
      state.personal.accountId = el("personalAccountSelect").value;
      saveLocal();
      refreshUploadReady();
    });
    state.personal.accountId = el("personalAccountSelect").value || null;

    state.personal.categories = await YnabClient.listCategories(budgetId);
    refreshUploadReady();
  } catch (e) {
    setStatus("connectStatus", e.message, "error");
  }
}

async function onBusinessBudgetChange() {
  const budgetId = el("businessBudgetSelect").value;
  state.business.budgetId = budgetId;
  if (!budgetId) return;
  saveLocal();
  try {
    const accounts = await YnabClient.listAccounts(budgetId);
    state.business.accounts = accounts;
    const opts = accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("");
    el("businessIngAccountSelect").innerHTML = `<option value="">Choose…</option>${opts}`;
    el("businessAmexAccountSelect").innerHTML = `<option value="">Choose…</option>${opts}`;

    const saved = loadLocal();
    if (saved?.business?.accountIdING) el("businessIngAccountSelect").value = saved.business.accountIdING;
    if (saved?.business?.accountIdAMEX) el("businessAmexAccountSelect").value = saved.business.accountIdAMEX;
    state.business.accountIdING = el("businessIngAccountSelect").value || null;
    state.business.accountIdAMEX = el("businessAmexAccountSelect").value || null;

    el("businessIngAccountSelect").addEventListener("change", () => {
      state.business.accountIdING = el("businessIngAccountSelect").value;
      saveLocal();
      refreshUploadReady();
    });
    el("businessAmexAccountSelect").addEventListener("change", () => {
      state.business.accountIdAMEX = el("businessAmexAccountSelect").value;
      saveLocal();
      refreshUploadReady();
    });

    state.business.categories = await YnabClient.listCategories(budgetId);
    refreshUploadReady();
  } catch (e) {
    setStatus("connectStatus", e.message, "error");
  }
}

// ---------- date range ----------
function pad(n) { return String(n).padStart(2, "0"); }
function toIso(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function computeRangeForPreset(preset) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (preset === "last7") {
    const from = new Date(today); from.setDate(from.getDate() - 6);
    return { from: toIso(from), to: toIso(today) };
  }
  if (preset === "last14") {
    const from = new Date(today); from.setDate(from.getDate() - 13);
    return { from: toIso(from), to: toIso(today) };
  }
  if (preset === "sinceMonday") {
    const dow = today.getDay(); // 0 = Sunday
    const daysSinceMonday = (dow + 6) % 7;
    const from = new Date(today); from.setDate(from.getDate() - daysSinceMonday);
    return { from: toIso(from), to: toIso(today) };
  }
  if (preset === "weekend") {
    // most recent Saturday through most recent Sunday (or today if it's the weekend)
    const dow = today.getDay();
    const daysSinceSaturday = (dow + 1) % 7; // Sat=6 -> 0, Sun=0 -> 1, Mon=1 -> 2...
    const sat = new Date(today); sat.setDate(sat.getDate() - daysSinceSaturday);
    const sun = new Date(sat); sun.setDate(sun.getDate() + 1);
    const to = sun > today ? today : sun;
    return { from: toIso(sat), to: toIso(to) };
  }
  return null; // custom
}

function getDateRange() {
  const preset = el("dateRangePreset").value;
  if (preset === "custom") {
    const from = el("dateFrom").value.trim() || "1900-01-01";
    const to = el("dateTo").value.trim() || "2999-12-31";
    return { from, to };
  }
  return computeRangeForPreset(preset);
}

function updateDateRangeSummary() {
  const { from, to } = getDateRange();
  el("dateRangeSummary").textContent = `Checking transactions from ${from} to ${to}.`;
}

el("dateRangePreset").addEventListener("change", () => {
  const isCustom = el("dateRangePreset").value === "custom";
  el("customDateRow").classList.toggle("hidden", !isCustom);
  if (!isCustom) updateDateRangeSummary();
});
el("dateFrom").addEventListener("input", updateDateRangeSummary);
el("dateTo").addEventListener("input", updateDateRangeSummary);


let bankFiles = [], ynabFile = null, amexFiles = [];

el("bankFile").addEventListener("change", e => {
  bankFiles = Array.from(e.target.files);
  el("bankFileName").textContent = bankFiles.map(f => f.name).join(", ");
  refreshUploadReady();
});
el("ynabFile").addEventListener("change", e => {
  ynabFile = e.target.files[0] || null;
  el("ynabFileName").textContent = ynabFile ? ynabFile.name : "";
  refreshUploadReady();
});
el("amexFile").addEventListener("change", e => {
  amexFiles = Array.from(e.target.files);
  el("amexFileName").textContent = amexFiles.map(f => f.name).join(", ");
  refreshUploadReady();
});

function refreshUploadReady() {
  let baseReady, budgetReady;
  if (state.mode === "personal") {
    baseReady = bankFiles.length > 0 && ynabFile !== null;
    budgetReady = !!state.personal.budgetId && !!state.personal.accountId;
  } else {
    // Business mode: ING and AMEX are each independently optional — you might
    // be reconciling just one side. At least one bank source (ING file or
    // AMEX file) plus the YNAB export is required; whichever account(s)
    // correspond to the file(s) you've actually uploaded must be selected.
    const hasIngFile = bankFiles.length > 0;
    const hasAmexFile = amexFiles.length > 0;
    baseReady = (hasIngFile || hasAmexFile) && ynabFile !== null;

    const ingReady = !hasIngFile || !!state.business.accountIdING;
    const amexReady = !hasAmexFile || !!state.business.accountIdAMEX;
    budgetReady = !!state.business.budgetId && ingReady && amexReady;
  }
  el("uploadPanel").classList.toggle("hidden", !budgetReady);
  el("btnRunMatch").disabled = !(baseReady && budgetReady);
}

// ---------- run match ----------
el("btnRunMatch").addEventListener("click", runMatch);

async function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsText(file);
  });
}

async function runMatch() {
  setStatus("matchStatus", "Reading files…", "");
  try {
    const bankTexts = await Promise.all(bankFiles.map(readFileText));
    const ynabText = await readFileText(ynabFile);

    let bankTxns = [];
    if (state.mode === "personal") {
      bankTxns = bankTexts.flatMap(parseING);
    } else {
      const ingTxns = bankTexts.flatMap(parseING);
      let amexTxns = [];
      if (amexFiles.length > 0) {
        const amexTexts = await Promise.all(amexFiles.map(readFileText));
        amexTxns = parseAMEX(amexTexts);
      }
      bankTxns = [...ingTxns, ...amexTxns];
    }

    const ynabTxns = parseYNAB(ynabText);

    setStatus("matchStatus", "Pulling YNAB history for category guessing…", "");
    const budgetId = state.mode === "personal" ? state.personal.budgetId : state.business.budgetId;
    let historyTxns = [];
    try {
      const apiHistory = await YnabClient.listTransactions(budgetId, {});
      historyTxns = apiHistory.map(t => ({
        payee: t.payee_name || "",
        categoryGroup: t.category_name ? (t.category_name.split(":")[0] || "") : "",
        category: t.category_name || "",
        amount: t.amount / 1000
      }));
    } catch (e) {
      // non-fatal — fall back to using the uploaded YNAB CSV as history
      historyTxns = ynabTxns;
    }
    state.historyModel = buildHistoryModel(historyTxns);

    // Apply the date range filter to bank-side transactions before matching.
    const { from, to } = getDateRange();
    bankTxns = bankTxns.filter(t => t.date >= from && t.date <= to);

    let result;
    if (state.mode === "personal") {
      // single account — match everything against the full YNAB export
      result = findMissing(bankTxns, ynabTxns);
    } else {
      // Business mode: ING and AMEX must each be checked only against their
      // OWN YNAB account's rows, never against each other's. Mixing them was
      // the root cause of AMEX charges being flagged as missing from the
      // Bodega ING account instead of the AMEX account.
      const ingAccountName = state.business.accounts.find(a => a.id === state.business.accountIdING)?.name;
      const amexAccountName = state.business.accounts.find(a => a.id === state.business.accountIdAMEX)?.name;

      const ynabIng = ynabTxns.filter(t => t.account === ingAccountName);
      const ynabAmex = ynabTxns.filter(t => t.account === amexAccountName);
      const ynabOther = ynabTxns.filter(t => t.account !== ingAccountName && t.account !== amexAccountName);

      const bankIng = bankTxns.filter(t => t.source === "ING");
      const bankAmex = bankTxns.filter(t => t.source === "AMEX");

      const resultIng = findMissing(bankIng, ynabIng);
      const resultAmex = findMissing(bankAmex, ynabAmex);

      result = {
        missing: [...resultIng.missing, ...resultAmex.missing],
        matchedCount: resultIng.matchedCount + resultAmex.matchedCount,
        totalBank: bankTxns.length,
        totalYnab: ynabTxns.length
      };

      if (state.business.accountIdING && state.business.accountIdAMEX && ynabOther.length > 0) {
        logLine(`Note: ${ynabOther.length} YNAB row(s) belong to neither the selected ING nor AMEX account and were ignored for matching.`, true);
      }
    }

    const categories = state.mode === "personal" ? state.personal.categories : state.business.categories;

    state.lastMatchResult = result.missing.map((m, idx) => {
      const guess = guessForTransaction(m.desc, state.historyModel);
      return {
        id: idx,
        date: m.date,
        rawDesc: m.desc,
        amount: m.amount,
        sourceType: m.source,
        include: true,
        payee: guess.payee,
        categoryGroup: guess.categoryGroup,
        category: guess.category,
        confidence: guess.confidence,
        memo: ""
      };
    });

    renderSummary(result, bankTxns.length, { from, to });
    renderReviewTable(categories);
    el("resultsArea").classList.remove("hidden");
    setStatus("matchStatus", `Done — ${result.missing.length} gap(s) found out of ${bankTxns.length} bank transactions.`, "ok");
  } catch (e) {
    console.error(e);
    setStatus("matchStatus", e.message, "error");
  }
}

function renderSummary(result, totalBank, range) {
  el("summaryBar").innerHTML = `
    <div class="summary-stat"><div class="num">${totalBank}</div><div class="label">Bank transactions (${range.from} → ${range.to})</div></div>
    <div class="summary-stat"><div class="num">${result.matchedCount}</div><div class="label">Already in YNAB</div></div>
    <div class="summary-stat"><div class="num">${result.missing.length}</div><div class="label">Missing — need review</div></div>
  `;
}

function renderReviewTable(categories) {
  const rows = state.lastMatchResult;
  if (rows.length === 0) {
    const { from, to } = getDateRange();
    el("reviewTableWrap").innerHTML = `
      <div class="empty-state">
        <div class="big">✓ Fully reconciled</div>
        Every transaction from ${from} to ${to} is already in YNAB. Nothing to sync.
      </div>`;
    el("btnSync").disabled = true;
    return;
  }

  const catOptions = categories
    .map(c => `<option value="${c.id}" data-group="${escapeHtml(c.group)}" data-cat="${escapeHtml(c.name)}">${escapeHtml(c.fullLabel)}</option>`)
    .join("");

  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));

  let html = `<table class="review"><thead><tr>
    <th class="checkbox-cell"></th>
    <th>Date</th>
    <th>Bank description</th>
    <th>Payee</th>
    <th>Category</th>
    <th>Memo</th>
    <th>Amount</th>
  </tr></thead><tbody>`;

  for (const r of sorted) {
    const amtClass = r.amount < 0 ? "out" : "in";
    const confBadge = r.confidence === "high"
      ? `<span class="badge guess-high">matched history</span>`
      : `<span class="badge guess-low">no history match</span>`;
    html += `<tr data-id="${r.id}">
      <td class="checkbox-cell"><input type="checkbox" class="rowInclude" checked></td>
      <td>${r.date}<br>${confBadge}</td>
      <td style="max-width:180px;font-size:12px;color:var(--ink-soft)">${escapeHtml(r.rawDesc)}</td>
      <td><input type="text" class="rowPayee" value="${escapeHtml(r.payee)}"></td>
      <td><select class="rowCategory">
            <option value="">No category</option>
            ${catOptions}
          </select></td>
      <td><input type="text" class="rowMemo" value="${escapeHtml(r.memo)}"></td>
      <td class="amt ${amtClass}">${formatMoney(r.amount)}</td>
    </tr>`;
  }
  html += "</tbody></table>";
  el("reviewTableWrap").innerHTML = html;

  // pre-select guessed category in each select, now that DOM exists
  sorted.forEach(r => {
    if (!r.category) return;
    const tr = document.querySelector(`tr[data-id="${r.id}"]`);
    const sel = tr.querySelector(".rowCategory");
    const match = categories.find(c => c.name === r.category && c.group === r.categoryGroup);
    if (match) sel.value = match.id;
  });

  el("btnSync").disabled = false;
}

// ---------- sync ----------
el("btnSync").addEventListener("click", syncToYnab);

async function syncToYnab() {
  const budgetId = state.mode === "personal" ? state.personal.budgetId : state.business.budgetId;
  const accountId = state.mode === "personal" ? state.personal.accountId : null;

  const trs = Array.from(document.querySelectorAll("table.review tbody tr"));
  const toCreate = [];
  const occurrenceCounter = {};

  for (const tr of trs) {
    const checkbox = tr.querySelector(".rowInclude");
    if (!checkbox.checked) continue;
    const id = parseInt(tr.dataset.id, 10);
    const row = state.lastMatchResult.find(r => r.id === id);
    const payee = tr.querySelector(".rowPayee").value.trim();
    const categoryId = tr.querySelector(".rowCategory").value || null;
    const memo = tr.querySelector(".rowMemo").value.trim();

    // Business mode: which account a row posts to depends on its source (ING vs AMEX)
    let targetAccountId = accountId;
    if (state.mode === "business") {
      targetAccountId = row.sourceType === "AMEX" ? state.business.accountIdAMEX : state.business.accountIdING;
    }
    if (!targetAccountId) {
      setStatus("syncStatus", `No YNAB account configured for ${row.sourceType} transactions — set this up before syncing.`, "error");
      return;
    }

    const milliunits = Math.round(row.amount * 1000);
    const dedupeKey = `${milliunits}:${row.date}`;
    occurrenceCounter[dedupeKey] = (occurrenceCounter[dedupeKey] || 0) + 1;
    const importId = YnabClient.buildImportId(milliunits, row.date, occurrenceCounter[dedupeKey]);

    toCreate.push({
      account_id: targetAccountId,
      date: row.date,
      amount: milliunits,
      payee_name: payee || undefined,
      category_id: categoryId || undefined,
      memo: memo || undefined,
      cleared: "cleared",
      approved: false,
      import_id: importId
    });
  }

  if (toCreate.length === 0) {
    setStatus("syncStatus", "Nothing selected to sync.", "error");
    return;
  }

  el("btnSync").disabled = true;
  setStatus("syncStatus", `Syncing ${toCreate.length} transaction(s)…`, "");
  logLine(`Posting ${toCreate.length} transaction(s) to budget ${budgetId}…`, true);

  try {
    const res = await YnabClient.createTransactions(budgetId, toCreate);
    const created = res?.data?.transactions || [];
    const duplicates = res?.data?.duplicate_import_ids || [];
    logLine(`Created: ${created.length}`);
    if (duplicates.length > 0) {
      logLine(`Skipped as duplicates (already synced previously): ${duplicates.length}`);
    }
    setStatus("syncStatus", `Synced — ${created.length} created, ${duplicates.length} already existed.`, "ok");
    // remove synced rows from the table
    trs.forEach(tr => {
      const checkbox = tr.querySelector(".rowInclude");
      if (checkbox.checked) tr.remove();
    });
  } catch (e) {
    logLine(`Error: ${e.message}`);
    setStatus("syncStatus", e.message, "error");
  } finally {
    el("btnSync").disabled = false;
  }
}

// ---------- helpers ----------
function setStatus(id, text, kind) {
  const node = el(id);
  node.textContent = text;
  node.className = "status-line" + (kind ? " " + kind : "");
}

function formatMoney(n) {
  const sign = n < 0 ? "-" : "+";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function resetResults() {
  el("resultsArea").classList.add("hidden");
  el("reviewTableWrap").innerHTML = "";
  el("summaryBar").innerHTML = "";
}

function logLine(text, clear = false) {
  const box = el("logBox");
  box.classList.remove("hidden");
  if (clear) box.textContent = "";
  box.textContent += text + "\n";
  box.scrollTop = box.scrollHeight;
}

// ---------- init ----------
(function init() {
  const saved = loadLocal();
  if (saved?.token) {
    el("tokenInput").value = saved.token;
    connect();
  }
  setMode("personal");

  // sensible custom-range defaults so the fields aren't blank if selected
  const today = new Date();
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 6);
  el("dateFrom").value = toIso(weekAgo);
  el("dateTo").value = toIso(today);
  updateDateRangeSummary();
})();
