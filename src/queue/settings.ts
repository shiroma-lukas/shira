import type { SqlClient } from "../db/migrate.js";

/** Platform-wide switches stored in platform_settings. */
export class Settings {
  constructor(private readonly db: SqlClient) {}

  private async get<T>(key: string): Promise<T> {
    const { rows } = await this.db.query<{ value: T }>("SELECT value FROM platform_settings WHERE key = $1", [key]);
    if (!rows[0]) throw new Error(`missing platform setting ${key}`);
    return rows[0].value;
  }

  private async set(key: string, value: unknown, actor: string): Promise<void> {
    await this.db.query(
      `INSERT INTO platform_settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), actor],
    );
  }

  /** Kill switch (FR-S4). While on, no task is claimed. */
  agentsPaused(): Promise<boolean> {
    return this.get<boolean>("agents_paused");
  }

  setAgentsPaused(paused: boolean, actor: string): Promise<void> {
    return this.set("agents_paused", paused, actor);
  }

  monthlyBudgetUsd(): Promise<number | null> {
    return this.get<number | null>("monthly_budget_usd");
  }

  setMonthlyBudgetUsd(usd: number | null, actor: string): Promise<void> {
    if (usd !== null && !(usd > 0)) throw new Error("monthly budget must be positive or null");
    return this.set("monthly_budget_usd", usd, actor);
  }
}
