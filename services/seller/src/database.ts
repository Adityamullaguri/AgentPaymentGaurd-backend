import Database from "better-sqlite3";

export function initializeSellerDatabase(
  database: Database.Database,
  currency = "usd",
): void {
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      price INTEGER NOT NULL,
      currency TEXT NOT NULL,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS offers (
      payment_intent_id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL REFERENCES resources(id),
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'redeemed', 'expired')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      redeemed_at TEXT
    );
  `);

  const seedResource = database.prepare(`
    INSERT OR IGNORE INTO resources (id, title, price, currency, payload)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateSeedCurrency = database.prepare(
    "UPDATE resources SET currency = ? WHERE id = ?",
  );

  seedResource.run(
    "market-prices",
    "Market Prices",
    100,
    currency,
    JSON.stringify({
      prices: [
        { symbol: "ACME", price: 42.5 },
        { symbol: "GLOB", price: 18.75 },
      ],
      as_of: "2026-11-03T00:00:00.000Z",
    }),
  );
  seedResource.run(
    "premium-dataset",
    "Premium Dataset",
    400,
    currency,
    JSON.stringify({
      dataset: "premium-market-signals",
      records: [
        { symbol: "ACME", signal: "positive" },
        { symbol: "GLOB", signal: "neutral" },
      ],
    }),
  );
  updateSeedCurrency.run(currency, "market-prices");
  updateSeedCurrency.run(currency, "premium-dataset");
}
