import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeSellerDatabase } from "./database.js";
import {
  createSellerApp,
  type PaymentIntentDetails,
  type PaymentProvider,
} from "./seller.js";

class FakePaymentProvider implements PaymentProvider {
  paymentIntent: PaymentIntentDetails = {
    id: "pi_test_1",
    status: "requires_payment_method",
    amount: 100,
    currency: "usd",
    metadata: { seller_id: "seller_demo", resource_id: "market-prices" },
  };
  createCalls: Array<Parameters<PaymentProvider["createPaymentIntent"]>[0]> = [];
  retrieveError: Error | undefined;
  onRetrieve: (() => void) | undefined;

  async createPaymentIntent(
    input: Parameters<PaymentProvider["createPaymentIntent"]>[0],
  ): Promise<PaymentIntentDetails> {
    this.createCalls.push(input);
    this.paymentIntent = {
      ...this.paymentIntent,
      id: `pi_test_${this.createCalls.length}`,
    };
    return this.paymentIntent;
  }

  async retrievePaymentIntent(): Promise<PaymentIntentDetails> {
    this.onRetrieve?.();
    if (this.retrieveError) {
      throw this.retrieveError;
    }
    return this.paymentIntent;
  }
}

describe("seller paid resource endpoint", () => {
  let database: Database.Database;
  let provider: FakePaymentProvider;
  let server: Server;
  let baseUrl: string;
  let currentNow: Date;

  beforeEach(async () => {
    database = new Database(":memory:");
    initializeSellerDatabase(database);
    provider = new FakePaymentProvider();
    currentNow = new Date("2026-11-03T12:00:00.000Z");
    server = createServer(
      createSellerApp({
        database,
        paymentProvider: provider,
        now: () => currentNow,
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind to a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    database.close();
  });

  it("creates an unconfirmed intent and returns 402 payment terms", async () => {
    const response = await fetch(`${baseUrl}/v1/data/market-prices`);
    const body = await response.json();

    expect(response.status).toBe(402);
    expect(response.headers.get("www-authenticate")).toBe('Payment intent="pi_test_1"');
    expect(body.payment_required).toMatchObject({
      seller_id: "seller_demo",
      resource_id: "market-prices",
      amount: 100,
      currency: "usd",
      payment_intent_id: "pi_test_1",
    });
    expect(provider.createCalls[0]).toMatchObject({
      amount: 100,
      currency: "usd",
      confirm: false,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: { seller_id: "seller_demo", resource_id: "market-prices" },
    });
  });

  it("delivers verified data once and rejects replay", async () => {
    await fetch(`${baseUrl}/v1/data/market-prices`);
    provider.paymentIntent.status = "succeeded";

    const first = await fetch(`${baseUrl}/v1/data/market-prices`, {
      headers: { "X-Payment-Intent": "pi_test_1" },
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      resource_id: "market-prices",
      data: { prices: expect.any(Array) },
      receipt_id: expect.stringMatching(/^rcpt_/),
    });

    const replay = await fetch(`${baseUrl}/v1/data/market-prices`, {
      headers: { "X-Payment-Intent": "pi_test_1" },
    });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      error: { code: "ALREADY_REDEEMED" },
    });
  });

  it("does not redeem an offer that expires during Stripe verification", async () => {
    await fetch(`${baseUrl}/v1/data/market-prices`);
    provider.paymentIntent.status = "succeeded";
    provider.onRetrieve = () => {
      currentNow = new Date(currentNow.getTime() + 16 * 60 * 1000);
    };

    const response = await fetch(`${baseUrl}/v1/data/market-prices`, {
      headers: { "X-Payment-Intent": "pi_test_1" },
    });

    expect(response.status).toBe(402);
    expect((await response.json()).payment_required.payment_intent_id).toBe("pi_test_2");
    expect(
      (database
        .prepare("SELECT status FROM offers WHERE payment_intent_id = ?")
        .get("pi_test_1") as { status: string }).status,
    ).toBe("expired");
  });

  it("returns another 402 rather than delivering data for an unknown intent", async () => {
    const response = await fetch(`${baseUrl}/v1/data/market-prices`, {
      headers: { "X-Payment-Intent": "pi_forged" },
    });

    expect(response.status).toBe(402);
    expect((await response.json()).payment_required.payment_intent_id).toBe("pi_test_1");
  });

  it("keeps an unpaid intent at 402", async () => {
    await fetch(`${baseUrl}/v1/data/market-prices`);
    const response = await fetch(`${baseUrl}/v1/data/market-prices`, {
      headers: { "X-Payment-Intent": "pi_test_1" },
    });

    expect(response.status).toBe(402);
  });

  it("does not deliver data when the Stripe amount or currency differs", async () => {
    await fetch(`${baseUrl}/v1/data/market-prices`);
    provider.paymentIntent = {
      ...provider.paymentIntent,
      status: "succeeded",
      amount: 200,
    };
    const response = await fetch(`${baseUrl}/v1/data/market-prices`, {
      headers: { "X-Payment-Intent": "pi_test_1" },
    });

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error: { code: "PAYMENT_MISMATCH" },
    });
  });

  it("does not deliver data when Stripe returns a different intent", async () => {
    await fetch(`${baseUrl}/v1/data/market-prices`);
    provider.paymentIntent = {
      ...provider.paymentIntent,
      id: "pi_unrelated",
      status: "succeeded",
    };
    const response = await fetch(`${baseUrl}/v1/data/market-prices`, {
      headers: { "X-Payment-Intent": "pi_test_1" },
    });

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error: { code: "PAYMENT_MISMATCH" },
    });
  });

  it("does not consume an offer if stored resource data is invalid", async () => {
    await fetch(`${baseUrl}/v1/data/market-prices`);
    provider.paymentIntent.status = "succeeded";
    database
      .prepare("UPDATE resources SET payload = ? WHERE id = ?")
      .run("{invalid-json", "market-prices");
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await fetch(`${baseUrl}/v1/data/market-prices`, {
        headers: { "X-Payment-Intent": "pi_test_1" },
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error: { code: "INTERNAL_ERROR" },
      });
      expect(
        (database
          .prepare("SELECT status FROM offers WHERE payment_intent_id = ?")
          .get("pi_test_1") as { status: string }).status,
      ).toBe("pending");
    } finally {
      logError.mockRestore();
    }
  });

  it("returns JSON for malformed requests and unknown routes", async () => {
    const invalidRequest = await fetch(`${baseUrl}/v1/data/market-prices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid-json",
    });
    expect(invalidRequest.status).toBe(400);
    expect(await invalidRequest.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });

    const notFound = await fetch(`${baseUrl}/missing`);
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("returns 502 if Stripe verification fails", async () => {
    await fetch(`${baseUrl}/v1/data/market-prices`);
    provider.retrieveError = new Error("Stripe unavailable");
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await fetch(`${baseUrl}/v1/data/market-prices`, {
        headers: { "X-Payment-Intent": "pi_test_1" },
      });

      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        error: { code: "PAYMENT_PROVIDER_ERROR" },
      });
      expect(logError).toHaveBeenCalledWith(
        "Seller Stripe PaymentIntent lookup failed",
        { errorType: "Error" },
      );
    } finally {
      logError.mockRestore();
    }
  });

  it("seeds resource prices using the configured currency", () => {
    const configuredDatabase = new Database(":memory:");
    try {
      initializeSellerDatabase(configuredDatabase, "usd");
      initializeSellerDatabase(configuredDatabase, "eur");
      const currencies = configuredDatabase
        .prepare("SELECT DISTINCT currency FROM resources")
        .all() as Array<{ currency: string }>;

      expect(currencies).toEqual([{ currency: "eur" }]);
    } finally {
      configuredDatabase.close();
    }
  });
});
