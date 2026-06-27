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
  // Mirrors YNAB's own format loosely: RECON:<milliunits>:<date>:<n>
  buildImportId(amountMilliunits, isoDate, occurrence) {
    return `RECON:${amountMilliunits}:${isoDate}:${occurrence}`;
  },

  // transactions: array of YNAB transaction objects (already shaped correctly)
  async createTransactions(budgetId, transactions) {
    return this._post(`/budgets/${budgetId}/transactions`, { transactions });
  }
};
