// ynab-client.js
// Thin wrapper around the YNAB v1 REST API.
// Docs: https://api.ynab.com/v1

const YNAB_BASE = "https://api.ynab.com/v1";

const YnabClient = {
  token: null,

  setToken(t) {
    this.token = t.trim();
  },

  async _get(path) {
    const res = await fetch(`${YNAB_BASE}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        `YNAB GET ${path} failed: ${res.status} ${body?.error?.detail || res.statusText}`
      );
    }
    return res.json();
  },

  async _post(path, payload) {
    const res = await fetch(`${YNAB_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        `YNAB POST ${path} failed: ${res.status} ${body?.error?.detail || res.statusText}`
      );
    }
    return body;
  },

  // Returns [{id, name}]
  async listBudgets() {
    const data = await this._get("/budgets");
    return data.data.budgets.map(b => ({ id: b.id, name: b.name }));
  },

  // Returns [{id, name, type, on_budget, closed}]
  async listAccounts(budgetId) {
    const data = await this._get(`/budgets/${budgetId}/accounts`);
    return data.data.accounts
      .filter(a => !a.closed)
      .map(a => ({ id: a.id, name: a.name, type: a.type, on_budget: a.on_budget }));
  },

  // Returns flattened list of leaf categories (excludes category groups themselves)
  // [{id, name, group, group_id}]
  async listCategories(budgetId) {
    const data = await this._get(`/budgets/${budgetId}/categories`);
    const out = [];
    for (const group of data.data.category_groups) {
      if (group.hidden || group.deleted) continue;
      for (const cat of group.categories) {
        if (cat.hidden || cat.deleted) continue;
        out.push({
          id: cat.id,
          name: cat.name,
          group: group.name,
          group_id: group.id,
          fullLabel: `${group.name}: ${cat.name}`
        });
      }
    }
    return out;
  },

  // Returns category groups only, for picking a parent group when creating a new category.
  // [{id, name}]
  async listCategoryGroups(budgetId) {
    const data = await this._get(`/budgets/${budgetId}/categories`);
    return data.data.category_groups
      .filter(g => !g.hidden && !g.deleted)
      .map(g => ({ id: g.id, name: g.name }));
  },

  // Creates a new category within an existing category group.
  // YNAB's API requires a category_group_id — categories can't be created
  // "loose," so the caller must pick (or create) a group first.
  async createCategory(budgetId, categoryGroupId, name) {
    const data = await this._post(`/budgets/${budgetId}/categories`, {
      category: { category_group_id: categoryGroupId, name }
    });
    const c = data.data.category;
    return { id: c.id, name: c.name, group_id: c.category_group_id };
  },

  // Pull existing transactions for a budget (optionally a single account) so the
  // app can build a payee/category history model for guessing.
  // since_date format: YYYY-MM-DD
  async listTransactions(budgetId, { accountId = null, sinceDate = null } = {}) {
    let path = accountId
      ? `/budgets/${budgetId}/accounts/${accountId}/transactions`
      : `/budgets/${budgetId}/transactions`;
    if (sinceDate) path += `?since_date=${sinceDate}`;
    const data = await this._get(path);
    return data.data.transactions;
  },

  // Build a deterministic import_id so re-running a sync never double-creates.
  // Includes a short hash of the payee name so same-amount/same-date transactions
  // from different merchants don't collide (e.g. two $10.35 charges on the same day).
  // Format: RECON:<milliunits>:<date>:<payeeHash>:<n>
  buildImportId(amountMilliunits, isoDate, payeeName, occurrence) {
    // simple djb2-style hash of the payee string, kept short (base36, 6 chars)
    let hash = 5381;
    const s = (payeeName || "").toUpperCase();
    for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash) + s.charCodeAt(i);
    const shortHash = Math.abs(hash >>> 0).toString(36).slice(0, 6);
    return `RECON:${amountMilliunits}:${isoDate}:${shortHash}:${occurrence}`;
  },

  // transactions: array of YNAB transaction objects (already shaped correctly)
  async createTransactions(budgetId, transactions) {
    return this._post(`/budgets/${budgetId}/transactions`, { transactions });
  }
};
