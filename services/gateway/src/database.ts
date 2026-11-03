import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { PolicyConfig } from "@agentpay/shared";

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  per_purchase_cap: 500,
  daily_cap: 500,
  approval_threshold: 300,
  velocity_max: 5,
  velocity_window_s: 10,
  allowed_sellers: ["seller_demo"],
  allowed_currencies: ["usd"],
  auto_freeze_on_velocity: true,
};

export interface GatewayDatabaseOptions {
  buyerAgentKey: string;
  currency?: string;
  policyMode?: "guarded" | "passthrough";
  now?: () => Date;
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

export function initializeGatewayDatabase(
  database: Database.Database,
  {
    buyerAgentKey,
    currency = "usd",
    policyMode = "guarded",
    now = () => new Date(),
  }: GatewayDatabaseOptions,
): void {
  if (!buyerAgentKey) {
    throw new Error("BUYER_AGENT_KEY must be configured");
  }
  if (policyMode !== "guarded" && policyMode !== "passthrough") {
    throw new Error("POLICY_MODE must be 'guarded' or 'passthrough'");
  }

  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key_hash TEXT NOT NULL,
      frozen INTEGER NOT NULL DEFAULT 0,
      frozen_reason TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS policies (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id),
      per_purchase_cap INTEGER NOT NULL,
      daily_cap INTEGER NOT NULL,
      approval_threshold INTEGER NOT NULL,
      velocity_max INTEGER NOT NULL,
      velocity_window_s INTEGER NOT NULL,
      allowed_sellers TEXT NOT NULL,
      allowed_currencies TEXT NOT NULL,
      auto_freeze_on_velocity INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      payment_intent_id TEXT NOT NULL UNIQUE,
      seller_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      currency TEXT NOT NULL,
      purpose TEXT,
      status TEXT NOT NULL CHECK (status IN
        ('processing','succeeded','pending_approval','denied','rejected','failed')),
      decision TEXT NOT NULL CHECK (decision IN ('allow','deny','needs_approval')),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_txn_agent_day ON transactions(agent_id, created_at);

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL REFERENCES transactions(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      amount INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
      note TEXT,
      requested_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      agent_id TEXT,
      event TEXT NOT NULL,
      reason TEXT,
      amount INTEGER,
      ref_id TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const timestamp = now().toISOString();
  database
    .prepare(
      `INSERT INTO agents (id, name, api_key_hash, frozen, frozen_reason, created_at)
       VALUES (?, ?, ?, 0, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         api_key_hash = excluded.api_key_hash`,
    )
    .run("agent_buyer_1", "Buyer Agent 1", hashApiKey(buyerAgentKey), timestamp);

  database
    .prepare(
      `INSERT OR IGNORE INTO policies
       (agent_id, per_purchase_cap, daily_cap, approval_threshold, velocity_max,
        velocity_window_s, allowed_sellers, allowed_currencies,
        auto_freeze_on_velocity, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent_buyer_1",
      DEFAULT_POLICY_CONFIG.per_purchase_cap,
      DEFAULT_POLICY_CONFIG.daily_cap,
      DEFAULT_POLICY_CONFIG.approval_threshold,
      DEFAULT_POLICY_CONFIG.velocity_max,
      DEFAULT_POLICY_CONFIG.velocity_window_s,
      JSON.stringify(DEFAULT_POLICY_CONFIG.allowed_sellers),
      JSON.stringify([currency.toLowerCase()]),
      Number(DEFAULT_POLICY_CONFIG.auto_freeze_on_velocity),
      timestamp,
    );

  database
    .prepare(
      "INSERT OR IGNORE INTO settings (key, value) VALUES ('policy_mode', ?)",
    )
    .run(policyMode);
}
