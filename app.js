// app.js
// Wires together: mode switching, YNAB connect/budget selection, file uploads,
// running the matcher, rendering the review table, and syncing confirmed rows.

const state = {
  mode: "personal", // 'personal' | 'business'
  token: null,
  budgets: [],
  personal: { budgetId: null, accountId: null, accountIdNAB: null, accounts: [], categories: [], payees: [] },
  business: { budgetId: null, accountIdING: null, accountIdAMEX: null, accounts: [], categories: [], payees: [] },
  historyModel: null,
  lastMatchResult: null, // array of review rows
};

const el = id => document.getElementById(id);

// ---------- persistence ----------
function saveLocal() {
  const toSave = {
    token: state.token,
    personal: { budgetId: state.personal.budgetId, accountId: state.personal.accountId, accountIdNAB: state.personal.accountIdNAB },
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
  el("nabRow").classList.toggle("hidden", mode !== "personal");
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
    el("personalNabAccountSelect").innerHTML = `<option value="">Choose… (or leave blank)</option>${opts}`;
    const saved = loadLocal();
    if (saved?.personal?.accountId) el("personalAccountSelect").value = saved.personal.accountId;
    if (saved?.personal?.accountIdNAB) el("personalNabAccountSelect").value = saved.personal.accountIdNAB;

    el("personalAccountSelect").addEventListener("change", () => {
      state.personal.accountId = el("personalAccountSelect").value;
      saveLocal();
      refreshUploadReady();
    });
    el("personalNabAccountSelect").addEventListener("change", () => {
      state.personal.accountIdNAB = el("personalNabAccountSelect").value || null;
      saveLocal();
      refreshUploadReady();
    });

    state.personal.accountId = el("personalAccountSelect").value || null;
    state.personal.accountIdNAB = el("personalNabAccountSelect").value || null;

    state.personal.categories = await YnabClient.listCategories(budgetId);
    state.personal.payees = await YnabClient.listPayees(budgetId);
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
    state.business.payees = await YnabClient.listPayees(budgetId);
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


let bankFiles = [], ynabFile = null, amexFiles = [], nabFiles = [];

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
el("nabFile").addEventListener("change", e => {
  nabFiles = Array.from(e.target.files);
  el("nabFileName").textContent = nabFiles.map(f => f.name).join(", ");
  refreshUploadReady();
});

function refreshUploadReady() {
  let baseReady, budgetReady;
  if (state.mode === "personal") {
    // At least one bank source (ING or NAB) required plus the YNAB export.
    // NAB account only required if NAB files are actually uploaded.
    const hasIngFile = bankFiles.length > 0;
    const hasNabFile = nabFiles.length > 0;
    baseReady = (hasIngFile || hasNabFile) && ynabFile !== null;
    const nabReady = !hasNabFile || !!state.personal.accountIdNAB;
    budgetReady = !!state.personal.budgetId && !!state.personal.accountId && nabReady;
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
  // clear log from any previous sync session
  const logBox = el("logBox");
  logBox.classList.add("hidden");
  logBox.textContent = "";
  try {
    const bankTexts = await Promise.all(bankFiles.map(readFileText));
    const ynabText = await readFileText(ynabFile);

    let bankTxns = [];
    if (state.mode === "personal") {
      const ingTxns = bankTexts.flatMap(parseING);
      let nabTxns = [];
      if (nabFiles.length > 0) {
        const nabTexts = await Promise.all(nabFiles.map(readFileText));
        nabTxns = parseNAB(nabTexts);
      }
      bankTxns = [...ingTxns, ...nabTxns];
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
    const categoriesForHistory = state.mode === "personal" ? state.personal.categories : state.business.categories;
    let historyTxns = [];
    try {
      const apiHistory = await YnabClient.listTransactions(budgetId, {});
      historyTxns = apiHistory.map(t => ({
        payee: t.payee_name || "",
        categoryId: t.category_id || null,
        amount: t.amount / 1000
      }));
    } catch (e) {
      // non-fatal — fall back to using the uploaded YNAB CSV as history.
      // The CSV only has category text, so resolve it against the real
      // category list to get a proper categoryId rather than guessing on strings.
      historyTxns = ynabTxns.map(t => {
        const match = categoriesForHistory.find(c => c.name === t.category);
        return { payee: t.payee, categoryId: match ? match.id : null, amount: t.amount };
      });
    }
    state.historyModel = buildHistoryModel(historyTxns);

    // Apply the date range filter to bank-side transactions before matching.
    const { from, to } = getDateRange();
    bankTxns = bankTxns.filter(t => t.date >= from && t.date <= to);

    let result;
    if (state.mode === "personal") {
      // Personal mode: ING and NAB are each matched against their own YNAB account,
      // same logic as Business mode to prevent cross-contamination.
      if (nabFiles.length === 0 || !state.personal.accountIdNAB) {
        // NAB not in play — match everything ING against full YNAB export
        result = findMissing(bankTxns, ynabTxns);
      } else {
        const ingAccountName = state.personal.accounts.find(a => a.id === state.personal.accountId)?.name;
        const nabAccountName = state.personal.accounts.find(a => a.id === state.personal.accountIdNAB)?.name;

        const ynabIng = ynabTxns.filter(t => t.account === ingAccountName);
        const ynabNab = ynabTxns.filter(t => t.account === nabAccountName);

        const bankIng = bankTxns.filter(t => t.source === "ING");
        const bankNab = bankTxns.filter(t => t.source === "NAB");

        const resultIng = findMissing(bankIng, ynabIng);
        const resultNab = findMissing(bankNab, ynabNab);

        result = {
          missing: [...resultIng.missing, ...resultNab.missing],
          matchedCount: resultIng.matchedCount + resultNab.matchedCount,
          totalBank: bankTxns.length,
          totalYnab: ynabTxns.length
        };
      }
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
    const payees = state.mode === "personal" ? state.personal.payees : state.business.payees;

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
        categoryId: guess.categoryId,
        confidence: guess.confidence,
        memo: ""
      };
    });

    renderSummary(result, bankTxns.length, { from, to });
    renderReviewTable(categories, payees);
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

function renderReviewTable(categories, payees) {
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

  // build category options grouped by YNAB group
  const byGroup = {};
  categories.forEach(c => {
    if (!byGroup[c.group]) byGroup[c.group] = [];
    byGroup[c.group].push(c);
  });

  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));

  // filter bar + sort controls
  let filterHtml = `
    <div class="review-controls" style="display:flex;gap:10px;align-items:center;padding:14px 0 10px;flex-wrap:wrap;">
      <input type="text" id="reviewFilter" placeholder="Filter by payee, date or amount…" style="flex:1;min-width:200px;margin-bottom:0;">
      <div style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--ink-soft);">
        Sort:
        <button class="sort-btn active" data-sort="date">Date</button>
        <button class="sort-btn" data-sort="amount">Amount</button>
        <button class="sort-btn" data-sort="payee">Payee</button>
      </div>
      <label style="font-size:12px;color:var(--ink-soft);display:flex;align-items:center;gap:4px;">
        <input type="checkbox" id="selectAll" checked> Select all
      </label>
    </div>`;

  let tableHtml = `<table class="review" id="reviewTable"><thead><tr>
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
      : `<span class="badge guess-low">no history</span>`;

    tableHtml += `<tr data-id="${r.id}" data-date="${r.date}" data-amount="${r.amount}" data-payee="${escapeHtml(r.payee)}">
      <td class="checkbox-cell"><input type="checkbox" class="rowInclude" checked></td>
      <td style="white-space:nowrap">${r.date}<br>${confBadge}</td>
      <td style="max-width:160px;font-size:12px;color:var(--ink-soft)">${escapeHtml(r.rawDesc)}</td>
      <td style="min-width:160px">
        <div class="payee-typeahead" style="position:relative">
          <input type="text" class="rowPayee" value="${escapeHtml(r.payee)}" placeholder="Search payees…" autocomplete="off">
          <div class="payee-dropdown hidden"></div>
        </div>
      </td>
      <td style="min-width:180px">
        <input type="text" class="rowCategorySearch" placeholder="Type to search…" autocomplete="off">
        <input type="hidden" class="rowCategoryId">
        <div class="cat-dropdown hidden"></div>
        <div class="newCategoryForm hidden" style="margin-top:6px;">
          <input type="text" class="newCategoryName" placeholder="New category name" style="margin-bottom:4px;">
          <select class="newCategoryGroup" style="margin-bottom:4px;"></select>
          <button class="secondary newCategoryConfirm" type="button" style="font-size:12px;padding:6px 10px;">Create</button>
          <button class="ghost newCategoryCancel" type="button" style="font-size:12px;">Cancel</button>
        </div>
      </td>
      <td><input type="text" class="rowMemo" value="${escapeHtml(r.memo)}"></td>
      <td class="amt ${amtClass}" style="white-space:nowrap">${formatMoney(r.amount)}</td>
    </tr>`;
  }
  tableHtml += "</tbody></table>";

  el("reviewTableWrap").innerHTML = filterHtml + tableHtml;

  // pre-fill category search text and hidden ID from guess
  sorted.forEach(r => {
    if (!r.categoryId) return;
    const cat = categories.find(c => c.id === r.categoryId);
    if (!cat) return;
    const tr = document.querySelector(`tr[data-id="${r.id}"]`);
    tr.querySelector(".rowCategorySearch").value = cat.fullLabel;
    tr.querySelector(".rowCategoryId").value = cat.id;
  });

  wirePayeeTypeaheads(payees);
  wireCategoryTypeaheads(categories, byGroup);
  wireFilterAndSort(sorted);
  wireSelectAll();
  el("btnSync").disabled = false;
}

// ---------- payee typeahead ----------
function wirePayeeTypeaheads(payees) {
  document.querySelectorAll(".payee-typeahead").forEach(wrap => {
    const input = wrap.querySelector(".rowPayee");
    const dropdown = wrap.querySelector(".payee-dropdown");

    function showPayees(q) {
      const matches = q.length === 0
        ? payees.slice(0, 8)
        : payees.filter(p => p.name.toLowerCase().includes(q.toLowerCase())).slice(0, 10);

      if (matches.length === 0) { dropdown.classList.add("hidden"); return; }
      dropdown.innerHTML = matches
        .map(p => `<div class="dd-item" data-name="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>`)
        .join("") + `<div class="dd-item dd-new" data-name="${escapeHtml(input.value)}">+ Use "<strong>${escapeHtml(input.value)}</strong>" as new payee</div>`;
      dropdown.classList.remove("hidden");
    }

    input.addEventListener("focus", () => showPayees(input.value));
    input.addEventListener("input", () => showPayees(input.value));
    input.addEventListener("keydown", e => {
      const items = [...dropdown.querySelectorAll(".dd-item")];
      const active = dropdown.querySelector(".dd-item.active");
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = active ? (items[items.indexOf(active) + 1] || items[0]) : items[0];
        active?.classList.remove("active"); next?.classList.add("active");
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = active ? (items[items.indexOf(active) - 1] || items[items.length - 1]) : items[items.length - 1];
        active?.classList.remove("active"); prev?.classList.add("active");
      } else if (e.key === "Enter") {
        e.preventDefault();
        const sel = dropdown.querySelector(".dd-item.active") || dropdown.querySelector(".dd-item");
        if (sel) { input.value = sel.dataset.name; dropdown.classList.add("hidden"); }
      } else if (e.key === "Escape") {
        dropdown.classList.add("hidden");
      }
    });
    dropdown.addEventListener("mousedown", e => {
      const item = e.target.closest(".dd-item");
      if (item) { input.value = item.dataset.name; dropdown.classList.add("hidden"); }
    });
    document.addEventListener("click", e => {
      if (!wrap.contains(e.target)) dropdown.classList.add("hidden");
    }, { capture: true });
  });
}

// ---------- category typeahead ----------
function wireCategoryTypeaheads(categories, byGroup) {
  const groupNames = [...new Set(categories.map(c => c.group))];

  document.querySelectorAll("tr[data-id]").forEach(tr => {
    const input = tr.querySelector(".rowCategorySearch");
    const hiddenId = tr.querySelector(".rowCategoryId");
    const dropdown = tr.querySelector(".cat-dropdown");
    const newForm = tr.querySelector(".newCategoryForm");
    const newName = tr.querySelector(".newCategoryName");
    const newGroup = tr.querySelector(".newCategoryGroup");
    const confirmBtn = tr.querySelector(".newCategoryConfirm");
    const cancelBtn = tr.querySelector(".newCategoryCancel");

    newGroup.innerHTML = groupNames.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");

    function showCats(q) {
      const lower = q.toLowerCase();
      const matches = q.length === 0
        ? categories.slice(0, 12)
        : categories.filter(c =>
            c.name.toLowerCase().includes(lower) ||
            c.group.toLowerCase().includes(lower) ||
            c.fullLabel.toLowerCase().includes(lower)
          ).slice(0, 12);

      let html = matches.map(c =>
        `<div class="dd-item" data-id="${c.id}" data-label="${escapeHtml(c.fullLabel)}">`+
        `<span style="font-size:11px;color:var(--ink-soft)">${escapeHtml(c.group)}</span><br>${escapeHtml(c.name)}</div>`
      ).join("");
      html += `<div class="dd-item dd-new" data-id="__new__">+ Create new category…</div>`;
      if (matches.length === 0 && q.length > 0) {
        html = `<div class="dd-item" style="color:var(--ink-soft);pointer-events:none">No match — </div>` + html;
      }
      dropdown.innerHTML = html;
      dropdown.classList.remove("hidden");
    }

    function clearCat() {
      hiddenId.value = "";
      input.value = "";
    }

    input.addEventListener("focus", () => showCats(input.value));
    input.addEventListener("input", () => { hiddenId.value = ""; showCats(input.value); });
    input.addEventListener("keydown", e => {
      const items = [...dropdown.querySelectorAll(".dd-item:not([style*='pointer-events:none'])")];
      const active = dropdown.querySelector(".dd-item.active");
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = active ? (items[items.indexOf(active) + 1] || items[0]) : items[0];
        active?.classList.remove("active"); next?.classList.add("active");
        next?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = active ? (items[items.indexOf(active) - 1] || items[items.length - 1]) : items[items.length - 1];
        active?.classList.remove("active"); prev?.classList.add("active");
        prev?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        const sel = dropdown.querySelector(".dd-item.active") || dropdown.querySelector(".dd-item");
        if (sel) pickCat(sel);
      } else if (e.key === "Escape") {
        dropdown.classList.add("hidden");
      } else if (e.key === "Backspace" && input.value === "") {
        clearCat();
      }
    });

    function pickCat(item) {
      if (item.dataset.id === "__new__") {
        dropdown.classList.add("hidden");
        input.classList.add("hidden");
        newForm.classList.remove("hidden");
        newName.value = input.value;
        newName.focus();
        return;
      }
      hiddenId.value = item.dataset.id;
      input.value = item.dataset.label;
      dropdown.classList.add("hidden");
    }

    dropdown.addEventListener("mousedown", e => {
      e.preventDefault();
      const item = e.target.closest(".dd-item");
      if (item) pickCat(item);
    });
    document.addEventListener("click", e => {
      if (!tr.querySelector("td:nth-child(5)").contains(e.target)) dropdown.classList.add("hidden");
    }, { capture: true });

    // create new category inline
    confirmBtn.addEventListener("click", async () => {
      const name = newName.value.trim();
      if (!name) { newName.focus(); return; }
      const groupName = newGroup.value;
      const group = categories.find(c => c.group === groupName);
      const budgetId = state.mode === "personal" ? state.personal.budgetId : state.business.budgetId;
      confirmBtn.disabled = true; confirmBtn.textContent = "Creating…";
      try {
        const newCat = await YnabClient.createCategory(budgetId, group.group_id, name);
        const fullNewCat = { id: newCat.id, name: newCat.name, group: groupName, group_id: group.group_id, fullLabel: `${groupName}: ${newCat.name}` };
        categories.push(fullNewCat);
        if (state.mode === "personal") state.personal.categories.push(fullNewCat);
        else state.business.categories.push(fullNewCat);
        hiddenId.value = newCat.id;
        input.value = fullNewCat.fullLabel;
        input.classList.remove("hidden");
        newForm.classList.add("hidden");
      } catch (e) {
        alert(`Couldn't create category: ${e.message}`);
      } finally {
        confirmBtn.disabled = false; confirmBtn.textContent = "Create";
      }
    });
    cancelBtn.addEventListener("click", () => {
      newForm.classList.add("hidden");
      input.classList.remove("hidden");
      input.focus();
    });
  });
}

// ---------- filter + sort ----------
let currentSort = "date";
let currentSortAsc = true;

function wireFilterAndSort(initialRows) {
  const filterInput = el("reviewFilter");
  const sortBtns = document.querySelectorAll(".sort-btn");

  function applyFilterSort() {
    const q = filterInput.value.toLowerCase();
    const trs = Array.from(document.querySelectorAll("#reviewTable tbody tr"));
    trs.forEach(tr => {
      const payee = tr.dataset.payee.toLowerCase();
      const date = tr.dataset.date;
      const amount = tr.dataset.amount;
      const visible = !q || payee.includes(q) || date.includes(q) || amount.includes(q);
      tr.style.display = visible ? "" : "none";
    });
    // sort visible rows
    const visible = trs.filter(tr => tr.style.display !== "none");
    visible.sort((a, b) => {
      let va, vb;
      if (currentSort === "date") { va = a.dataset.date; vb = b.dataset.date; }
      else if (currentSort === "amount") { va = parseFloat(a.dataset.amount); vb = parseFloat(b.dataset.amount); }
      else { va = a.dataset.payee.toLowerCase(); vb = b.dataset.payee.toLowerCase(); }
      return currentSortAsc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
    });
    const tbody = document.querySelector("#reviewTable tbody");
    visible.forEach(tr => tbody.appendChild(tr));
  }

  filterInput.addEventListener("input", applyFilterSort);
  sortBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      if (currentSort === btn.dataset.sort) { currentSortAsc = !currentSortAsc; }
      else { currentSort = btn.dataset.sort; currentSortAsc = true; }
      sortBtns.forEach(b => b.classList.toggle("active", b.dataset.sort === currentSort));
      applyFilterSort();
    });
  });
}

function wireSelectAll() {
  el("selectAll").addEventListener("change", e => {
    document.querySelectorAll(".rowInclude").forEach(cb => {
      if (cb.closest("tr").style.display !== "none") cb.checked = e.target.checked;
    });
  });
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
    const categoryId = tr.querySelector(".rowCategoryId")?.value || null;
    const memo = tr.querySelector(".rowMemo").value.trim();

    // Route to the correct YNAB account based on source type
    let targetAccountId = accountId; // default: personal ING account
    if (state.mode === "personal" && row.sourceType === "NAB") {
      targetAccountId = state.personal.accountIdNAB;
    } else if (state.mode === "business") {
      targetAccountId = row.sourceType === "AMEX" ? state.business.accountIdAMEX : state.business.accountIdING;
    }
    if (!targetAccountId) {
      setStatus("syncStatus", `No YNAB account configured for ${row.sourceType} transactions — set this up before syncing.`, "error");
      return;
    }

    const milliunits = Math.round(row.amount * 1000);
    const dedupeKey = `${milliunits}:${row.date}`;
    occurrenceCounter[dedupeKey] = (occurrenceCounter[dedupeKey] || 0) + 1;
    const importId = YnabClient.buildImportId(milliunits, row.date, payee, occurrenceCounter[dedupeKey]);

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
      logLine(`Skipped as duplicates: ${duplicates.length}`);

      if (created.length === 0) {
        // All were blocked as duplicates — these import_ids were registered by
        // a previous failed sync attempt. The transactions don't actually exist
        // in YNAB. Show a force-retry button to re-submit without import_ids.
        setStatus("syncStatus", `All ${duplicates.length} transaction(s) blocked as duplicates from a previous failed sync — click Force Retry to create them anyway.`, "error");
        showForceRetryButton(budgetId, toCreate);
      } else {
        setStatus("syncStatus", `Synced — ${created.length} created, ${duplicates.length} already existed in YNAB.`, "ok");
        trs.forEach(tr => { if (tr.querySelector(".rowInclude")?.checked) tr.remove(); });
      }
    } else {
      setStatus("syncStatus", `Synced — ${created.length} created.`, "ok");
      trs.forEach(tr => { if (tr.querySelector(".rowInclude")?.checked) tr.remove(); });
    }
  } catch (e) {
    logLine(`Error: ${e.message}`);
    setStatus("syncStatus", e.message, "error");
  } finally {
    el("btnSync").disabled = false;
  }
}

function showForceRetryButton(budgetId, toCreate) {
  // remove any existing force retry button first
  const existing = document.getElementById("btnForceRetry");
  if (existing) existing.remove();

  const btn = document.createElement("button");
  btn.id = "btnForceRetry";
  btn.className = "secondary";
  btn.textContent = "Force Retry (skip duplicate check)";
  btn.style.marginLeft = "12px";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Retrying…";
    logLine("Force retrying without import_ids…");
    try {
      // strip import_id so YNAB can't block on previously-seen IDs
      const stripped = toCreate.map(({ import_id, ...rest }) => rest);
      const res = await YnabClient.createTransactions(budgetId, stripped);
      const created = res?.data?.transactions || [];
      logLine(`Force retry created: ${created.length}`);
      setStatus("syncStatus", `Force retry succeeded — ${created.length} transaction(s) created.`, "ok");
      btn.remove();
      // clear the review table rows that were just synced
      document.querySelectorAll("table.review tbody tr").forEach(tr => {
        if (tr.querySelector(".rowInclude")?.checked) tr.remove();
      });
    } catch (e) {
      logLine(`Force retry error: ${e.message}`);
      setStatus("syncStatus", e.message, "error");
      btn.disabled = false;
      btn.textContent = "Force Retry (skip duplicate check)";
    }
  });

  // append next to the sync status line
  el("syncStatus").after(btn);
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

// ---------- drag and drop ----------
function setupDragDrop(zoneId, fileInputId, fileNameId, onFiles) {
  const zone = document.getElementById(zoneId)?.closest('.upload-zone');
  if (!zone) return;
  ['dragenter','dragover'].forEach(evt => {
    zone.addEventListener(evt, e => { e.preventDefault(); zone.style.borderColor = 'var(--accent)'; zone.style.background = 'var(--accent-soft)'; });
  });
  ['dragleave','drop'].forEach(evt => {
    zone.addEventListener(evt, e => { e.preventDefault(); zone.style.borderColor = ''; zone.style.background = ''; });
  });
  zone.addEventListener('drop', e => {
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.csv'));
    if (files.length === 0) return;
    // inject into the file input so the existing change handler fires
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    const input = document.getElementById(fileInputId);
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  });
}

// set up drag-drop for all upload zones after DOM is ready
setTimeout(() => {
  setupDragDrop('bankFile', 'bankFile', 'bankFileName');
  setupDragDrop('ynabFile', 'ynabFile', 'ynabFileName');
  setupDragDrop('amexFile', 'amexFile', 'amexFileName');
  setupDragDrop('nabFile', 'nabFile', 'nabFileName');
}, 0);
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
