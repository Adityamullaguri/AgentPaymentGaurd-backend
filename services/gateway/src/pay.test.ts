import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeGatewayDatabase } from "./database.js";
import { GatewayEventHub } from "./events.js";
import {
  createGatewayApp,
  type GatewayPaymentIntent,
  type GatewayPaymentProvider,
} from "./pay.js";

const BUYER_KEY = "test_buyer_key";
const ADMIN_KEY = "test_admin_key";
const PAYMENT_METHOD = "pm_card_visa";
const FIXED_NOW = new Date("2026-11-03T12:00:00.000Z");
const validRequest = {
  agent_id: "agent_buyer_1",
  payment_intent_id: "pi_test_1",
  seller_id: "seller_demo",
  resource_id: "market-prices",
  amount: 100,
  currency: "usd",
  purpose: "Price a basket",
};

class FakePaymentProvider implements GatewayPaymentProvider {
  intent: GatewayPaymentIntent = {
    id: "pi_test_1",
    status: "requires_payment_method",
    amount: 100,
    currency: "usd",
    metadata: { seller_id: "seller_demo", resource_id: "market-prices" },
  };
  retrieveError: Error | undefined;
  confirmError: Error | undefined;
  confirmThenThrow = false;
  confirmCalls: Array<{ id: string; paymentMethod: string }> = [];
  retrieveCalls: string[] = [];

  async retrievePaymentIntent(id: string): Promise<GatewayPaymentIntent> {
    this.retrieveCalls.push(id);
    if (this.retrieveError) {
      throw this.retrieveError;
    }
    return this.intent;
  }

  async confirmPaymentIntent(
    id: string,
    paymentMethod: string,
  ): Promise<GatewayPaymentIntent> {
    this.confirmCalls.push({ id, paymentMethod });
    if (this.confirmThenThrow) {
      this.intent = { ...this.intent, status: "succeeded" };
      throw new Error("Provider response lost after successful confirmation");
    }
    if (this.confirmError) {
      throw this.confirmError;
    }
    return { ...this.intent, status: "succeeded" };
  }
}

describe("gateway payment core", () => {
  let database: Database.Database;
  let provider: FakePaymentProvider;
  let server: Server;
  let baseUrl: string;
  let events: GatewayEventHub;
  let currentNow: Date;
  let demoScenarios: string[];
  let holdDemo: boolean;
  let demoSignal: AbortSignal | undefined;
  let demoStarted: Promise<void>;
  let markDemoStarted: () => void;

  beforeEach(async () => {
    database = new Database(":memory:");
    currentNow = FIXED_NOW;
    events = new GatewayEventHub();
    initializeGatewayDatabase(database, {
      buyerAgentKey: BUYER_KEY,
      policyMode: "guarded",
      now: () => currentNow,
    });
    provider = new FakePaymentProvider();
    demoScenarios = [];
    holdDemo = false;
    demoSignal = undefined;
    demoStarted = new Promise<void>((resolve) => {
      markDemoStarted = resolve;
    });
    server = createServer(
      createGatewayApp({
        database,
        paymentProvider: provider,
        paymentMethod: PAYMENT_METHOD,
        adminKey: ADMIN_KEY,
        events,
        now: () => currentNow,
        demoRunner: async (scenario, onOutput, signal) => {
          demoScenarios.push(scenario);
          onOutput("SUMMARY test demo");
          if (holdDemo) {
            demoSignal = signal;
            markDemoStarted();
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
          return 0;
        },
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

  async function postPayment(
    body = validRequest,
    key = BUYER_KEY,
  ): Promise<Response> {
    return fetch(`${baseUrl}/v1/pay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Key": key,
      },
      body: JSON.stringify(body),
    });
  }

  async function postAdmin(
    path: string,
    body?: unknown,
    method = "POST",
    key = ADMIN_KEY,
  ): Promise<Response> {
    return fetch(`${baseUrl}/v1/admin${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Key": key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function requestApproval(paymentIntentId = "pi_approval"): Promise<string> {
    const response = await postPayment({
      ...validRequest,
      payment_intent_id: paymentIntentId,
      amount: 400,
      resource_id: "premium-dataset",
    });
    expect(response.status).toBe(202);
    const result = await response.json() as { approval_id: string };
    return result.approval_id;
  }

  it("authenticates, applies policy, confirms once, and records the payment", async () => {
    const response = await postPayment();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "paid",
      payment_intent_id: "pi_test_1",
      decision: "allow",
      reason: "OK",
    });
    expect(provider.confirmCalls).toEqual([
      { id: "pi_test_1", paymentMethod: PAYMENT_METHOD },
    ]);
    expect(
      (database
        .prepare("SELECT status FROM transactions WHERE payment_intent_id = ?")
        .get("pi_test_1") as { status: string }).status,
    ).toBe("succeeded");
    expect(
      (database
        .prepare("SELECT event FROM audit_log ORDER BY id")
        .all() as Array<{ event: string }>).map(({ event }) => event),
    ).toEqual(["ALLOWED", "PAYMENT_SUCCEEDED"]);
  });

  it("rejects malformed requests and invalid agent keys before Stripe", async () => {
    const invalidRequest = await postPayment({ ...validRequest, amount: 1.5 });
    expect(invalidRequest.status).toBe(422);
    expect(await invalidRequest.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });

    const invalidKey = await postPayment(validRequest, "wrong-key");
    expect(invalidKey.status).toBe(401);
    expect(await invalidKey.json()).toMatchObject({
      error: { code: "BAD_AGENT_KEY" },
    });
    expect(provider.confirmCalls).toHaveLength(0);
  });

  it("records policy denials and does not call Stripe", async () => {
    database
      .prepare(
        `INSERT INTO transactions
         (id, agent_id, payment_intent_id, seller_id, resource_id, amount, currency,
          purpose, status, decision, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "txn_existing",
        "agent_buyer_1",
        "pi_existing",
        "seller_demo",
        "market-prices",
        450,
        "usd",
        "Existing purchase",
        "succeeded",
        "allow",
        "OK",
        FIXED_NOW.toISOString(),
        FIXED_NOW.toISOString(),
      );
    const response = await postPayment({
      ...validRequest,
      payment_intent_id: "pi_over_daily_cap",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "DAILY_CAP_EXCEEDED" },
    });
    expect(provider.confirmCalls).toHaveLength(0);
    expect(
      (database
        .prepare("SELECT event, reason FROM audit_log")
        .get() as { event: string; reason: string }),
    ).toEqual({ event: "DENIED", reason: "DAILY_CAP_EXCEEDED" });
  });

  it("returns 409 and appends a denial audit row for a reused intent", async () => {
    expect((await postPayment()).status).toBe(200);
    const observed: string[] = [];
    const unsubscribe = events.subscribe((name) => observed.push(name));
    const replay = await postPayment();
    unsubscribe();

    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      error: { code: "DUPLICATE_PAYMENT_INTENT" },
    });
    expect(provider.confirmCalls).toHaveLength(1);
    expect(observed).toEqual([]);
    expect(
      (database
        .prepare("SELECT event, reason FROM audit_log ORDER BY id")
        .all() as Array<{ event: string; reason: string }>).at(-1),
    ).toEqual({ event: "DENIED", reason: "DUPLICATE_PAYMENT_INTENT" });
  });

  it("creates an approval record without confirming an above-threshold purchase", async () => {
    const response = await postPayment({
      ...validRequest,
      payment_intent_id: "pi_approval",
      amount: 400,
      resource_id: "premium-dataset",
    });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      status: "pending_approval",
      reason: "APPROVAL_REQUIRED",
    });
    expect(body.approval_id).toMatch(/^apr_/);
    expect(provider.confirmCalls).toHaveLength(0);
    expect(
      (database
        .prepare(
          "SELECT status FROM transactions WHERE payment_intent_id = ?",
        )
        .get("pi_approval") as { status: string }).status,
    ).toBe("pending_approval");
    expect(
      (database
        .prepare("SELECT event FROM audit_log")
        .get() as { event: string }).event,
    ).toBe("NEEDS_APPROVAL");
  });

  it("fails closed and records a failed transaction if Stripe confirmation errors", async () => {
    provider.confirmError = new Error("Provider refused the test payment");
    const response = await postPayment();

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "PAYMENT_PROVIDER_ERROR" },
    });
    expect(
      (database
        .prepare(
          "SELECT status, reason FROM transactions WHERE payment_intent_id = ?",
        )
        .get("pi_test_1") as { status: string; reason: string }),
    ).toEqual({ status: "failed", reason: "PAYMENT_PROVIDER_ERROR" });
    expect(
      (database
        .prepare("SELECT event FROM audit_log ORDER BY id")
        .all() as Array<{ event: string }>).map(({ event }) => event),
    ).toEqual(["ALLOWED", "PAYMENT_FAILED"]);
  });

  it("recovers a successful Stripe confirmation when the confirmation response is lost", async () => {
    provider.confirmThenThrow = true;
    const response = await postPayment();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "paid",
      transaction_id: expect.stringMatching(/^txn_/),
    });
    expect(
      (database
        .prepare("SELECT status FROM transactions WHERE payment_intent_id = ?")
        .get("pi_test_1") as { status: string }).status,
    ).toBe("succeeded");
    expect(
      (database
        .prepare("SELECT event FROM audit_log ORDER BY id")
        .all() as Array<{ event: string }>).map(({ event }) => event),
    ).toEqual(["ALLOWED", "PAYMENT_SUCCEEDED"]);
  });

  it("accepts a matching PaymentIntent that is already succeeded without confirming it again", async () => {
    provider.intent = { ...provider.intent, status: "succeeded" };

    const response = await postPayment();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "paid",
      reason: "OK",
    });
    expect(provider.confirmCalls).toHaveLength(0);
    expect(
      (database
        .prepare("SELECT status FROM transactions WHERE payment_intent_id = ?")
        .get("pi_test_1") as { status: string }).status,
    ).toBe("succeeded");
  });

  it("keeps an ambiguous Stripe outcome processing until polling can reconcile it", async () => {
    provider.retrieveError = new Error("Stripe lookup unavailable");
    provider.confirmError = new Error("Confirmation response unavailable");
    const response = await postPayment();

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "processing",
      reason: "PAYMENT_RECONCILIATION_PENDING",
    });
    expect(
      (database
        .prepare("SELECT status FROM transactions WHERE payment_intent_id = ?")
        .get("pi_test_1") as { status: string }).status,
    ).toBe("processing");

    provider.retrieveError = undefined;
    provider.intent = { ...provider.intent, status: "succeeded" };
    const polled = await fetch(`${baseUrl}/v1/pay/pi_test_1`, {
      headers: { "X-Agent-Key": BUYER_KEY },
    });
    expect(await polled.json()).toMatchObject({
      status: "paid",
      reason: "OK",
    });
  });

  it("does not confirm a Stripe intent whose amount or currency differs", async () => {
    provider.intent = { ...provider.intent, amount: 500 };
    const response = await postPayment();

    expect(response.status).toBe(502);
    expect(provider.confirmCalls).toHaveLength(0);
    expect(
      (database
        .prepare(
          "SELECT status, reason FROM transactions WHERE payment_intent_id = ?",
        )
        .get("pi_test_1") as { status: string; reason: string }),
    ).toEqual({ status: "failed", reason: "PAYMENT_PROVIDER_ERROR" });
  });

  it("does not confirm an intent belonging to a different seller or resource", async () => {
    provider.intent = {
      ...provider.intent,
      metadata: { seller_id: "seller_other", resource_id: "other-resource" },
    };
    const response = await postPayment();

    expect(response.status).toBe(502);
    expect(provider.confirmCalls).toHaveLength(0);
    expect(
      (database
        .prepare(
          "SELECT status, reason FROM transactions WHERE payment_intent_id = ?",
        )
        .get("pi_test_1") as { status: string; reason: string }),
    ).toEqual({ status: "failed", reason: "PAYMENT_PROVIDER_ERROR" });
  });

  it("supports passthrough mode without disabling duplicate protection", async () => {
    database
      .prepare("UPDATE settings SET value = 'passthrough' WHERE key = 'policy_mode'")
      .run();
    provider.intent = { ...provider.intent, id: "pi_passthrough", amount: 501 };
    const oversized = await postPayment({
      ...validRequest,
      payment_intent_id: "pi_passthrough",
      amount: 501,
    });

    expect(oversized.status).toBe(200);
    expect(
      (await postPayment({
        ...validRequest,
        payment_intent_id: "pi_passthrough",
        amount: 501,
      })).status,
    ).toBe(409);
  });

  it("freezes an agent when the velocity circuit breaker trips", async () => {
    for (let index = 0; index < 5; index += 1) {
      const paymentIntentId = `pi_velocity_${index}`;
      provider.intent = {
        id: paymentIntentId,
        status: "requires_payment_method",
        amount: 100,
        currency: "usd",
        metadata: { seller_id: "seller_demo", resource_id: "market-prices" },
      };
      expect(
        (
          await postPayment({
            ...validRequest,
            payment_intent_id: paymentIntentId,
          })
        ).status,
      ).toBe(200);
    }
    provider.intent = {
      id: "pi_velocity_blocked",
      status: "requires_payment_method",
      amount: 100,
      currency: "usd",
      metadata: { seller_id: "seller_demo", resource_id: "market-prices" },
    };
    const blocked = await postPayment({
      ...validRequest,
      payment_intent_id: "pi_velocity_blocked",
    });

    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({
      error: { code: "VELOCITY_LIMIT_EXCEEDED" },
    });
    expect(
      (database
        .prepare("SELECT frozen, frozen_reason FROM agents WHERE id = ?")
        .get("agent_buyer_1") as { frozen: number; frozen_reason: string }).frozen,
    ).toBe(1);
    expect(
      (database
        .prepare("SELECT event FROM audit_log ORDER BY id DESC LIMIT 1")
        .get() as { event: string }).event,
    ).toBe("FROZEN");
  });

  it("returns an authenticated budget and payment status", async () => {
    await postPayment();
    const status = await fetch(`${baseUrl}/v1/pay/pi_test_1`, {
      headers: { "X-Agent-Key": BUYER_KEY },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      status: "paid",
      reason: "OK",
    });

    const budget = await fetch(
      `${baseUrl}/v1/agents/agent_buyer_1/budget`,
      { headers: { "X-Agent-Key": BUYER_KEY } },
    );
    expect(budget.status).toBe(200);
    expect(await budget.json()).toMatchObject({
      daily_cap: 500,
      spent_today: 100,
      pending_today: 0,
      remaining: 400,
      frozen: false,
    });

    const adminBudget = await fetch(
      `${baseUrl}/v1/agents/agent_buyer_1/budget`,
      { headers: { "X-Admin-Key": ADMIN_KEY } },
    );
    expect(adminBudget.status).toBe(200);
  });

  it("allows an admin to approve, confirm, audit, and poll a purchase", async () => {
    const approvalId = await requestApproval();
    provider.intent = {
      id: "pi_approval",
      status: "requires_payment_method",
      amount: 400,
      currency: "usd",
      metadata: { seller_id: "seller_demo", resource_id: "premium-dataset" },
    };

    const response = await postAdmin(
      `/approvals/${approvalId}/decision`,
      { decision: "approve", note: "Approved for demo" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "approved",
      approval_id: approvalId,
    });

    expect(provider.confirmCalls).toEqual([
      { id: "pi_approval", paymentMethod: PAYMENT_METHOD },
    ]);

    const paymentStatus = await fetch(`${baseUrl}/v1/pay/pi_approval`, {
      headers: { "X-Agent-Key": BUYER_KEY },
    });
    expect(await paymentStatus.json()).toMatchObject({
      status: "paid",
      reason: "APPROVAL_REQUIRED",
    });
    expect(
      (database
        .prepare("SELECT event FROM audit_log ORDER BY id")
        .all() as Array<{ event: string }>).map(({ event }) => event),
    ).toContain("APPROVED");
  });

  it("reconciles an approved payment that succeeded before its response was lost", async () => {
    const approvalId = await requestApproval("pi_recovered_approval");
    provider.intent = {
      id: "pi_recovered_approval",
      status: "requires_payment_method",
      amount: 400,
      currency: "usd",
      metadata: { seller_id: "seller_demo", resource_id: "premium-dataset" },
    };
    provider.confirmThenThrow = true;

    const response = await postAdmin(
      `/approvals/${approvalId}/decision`,
      { decision: "approve" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "approved",
      approval_id: approvalId,
    });
    expect(
      (database
        .prepare("SELECT status, reason FROM transactions WHERE payment_intent_id = ?")
        .get("pi_recovered_approval") as { status: string; reason: string }),
    ).toEqual({ status: "succeeded", reason: "APPROVAL_REQUIRED" });
  });

  it("keeps an ambiguous approved payment processing and reconciles it when polled", async () => {
    const approvalId = await requestApproval("pi_ambiguous_approval");
    provider.intent = {
      id: "pi_ambiguous_approval",
      status: "requires_payment_method",
      amount: 400,
      currency: "usd",
      metadata: { seller_id: "seller_demo", resource_id: "premium-dataset" },
    };
    provider.retrieveError = new Error("Stripe lookup unavailable");

    const response = await postAdmin(
      `/approvals/${approvalId}/decision`,
      { decision: "approve" },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "processing",
      reason: "PAYMENT_RECONCILIATION_PENDING",
    });
    expect(
      (database
        .prepare("SELECT status FROM transactions WHERE payment_intent_id = ?")
        .get("pi_ambiguous_approval") as { status: string }).status,
    ).toBe("processing");

    provider.retrieveError = undefined;
    provider.intent = { ...provider.intent, status: "succeeded" };
    const polled = await fetch(`${baseUrl}/v1/pay/pi_ambiguous_approval`, {
      headers: { "X-Agent-Key": BUYER_KEY },
    });
    expect(await polled.json()).toMatchObject({
      status: "paid",
      reason: "APPROVAL_REQUIRED",
    });
  });

  it("forwards unexpected async approval route errors to Express error handling", async () => {
    const approvalId = await requestApproval("pi_admin_route_error");
    database.exec(
      `CREATE TRIGGER fail_approval_audit
       BEFORE INSERT ON audit_log
       WHEN NEW.event = 'APPROVED'
       BEGIN SELECT RAISE(FAIL, 'test database failure'); END;`,
    );

    const response = await postAdmin(
      `/approvals/${approvalId}/decision`,
      { decision: "approve" },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "INTERNAL_ERROR" },
    });
    expect(
      (database
        .prepare("SELECT status FROM approvals WHERE id = ?")
        .get(approvalId) as { status: string }).status,
    ).toBe("pending");
    expect(provider.confirmCalls).toHaveLength(0);
  });

  it("does not approve an approval after its 120-second deadline before the sweeper runs", async () => {
    const approvalId = await requestApproval("pi_expiring_before_sweep");
    currentNow = new Date(FIXED_NOW.getTime() + 121_000);

    const response = await postAdmin(
      `/approvals/${approvalId}/decision`,
      { decision: "approve" },
    );

    expect(response.status).toBe(409);
    expect(provider.confirmCalls).toHaveLength(0);
    expect(
      (database
        .prepare("SELECT status FROM approvals WHERE id = ?")
        .get(approvalId) as { status: string }).status,
    ).toBe("expired");
    expect(
      (database
        .prepare("SELECT status FROM transactions WHERE payment_intent_id = ?")
        .get("pi_expiring_before_sweep") as { status: string }).status,
    ).toBe("rejected");
  });

  it("publishes approval requested and resolved events", async () => {
    const observed: string[] = [];
    const unsubscribe = events.subscribe((name) => observed.push(name));
    try {
      const approvalId = await requestApproval("pi_event_approval");
      const rejected = await postAdmin(
        `/approvals/${approvalId}/decision`,
        { decision: "reject" },
      );
      expect(rejected.status).toBe(200);
    } finally {
      unsubscribe();
    }

    expect(observed).toEqual([
      "transaction",
      "approval_requested",
      "approval_resolved",
      "transaction",
    ]);
  });

  it("rejects an approval without confirming its PaymentIntent", async () => {
    const approvalId = await requestApproval();
    const response = await postAdmin(
      `/approvals/${approvalId}/decision`,
      { decision: "reject", note: "Not needed" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "rejected",
      reason: "APPROVAL_REJECTED",
    });
    expect(provider.confirmCalls).toHaveLength(0);
    const status = await fetch(`${baseUrl}/v1/pay/pi_approval`, {
      headers: { "X-Agent-Key": BUYER_KEY },
    });
    expect(await status.json()).toMatchObject({
      status: "rejected",
      reason: "APPROVAL_REJECTED",
    });
  });

  it("rechecks the daily cap before approval and denies newly unsafe purchases", async () => {
    const approvalId = await requestApproval();
    database
      .prepare(
        `INSERT INTO transactions
         (id, agent_id, payment_intent_id, seller_id, resource_id, amount, currency,
          purpose, status, decision, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "txn_new_spend",
        "agent_buyer_1",
        "pi_new_spend",
        "seller_demo",
        "market-prices",
        200,
        "usd",
        "New spend",
        "succeeded",
        "allow",
        "OK",
        FIXED_NOW.toISOString(),
        FIXED_NOW.toISOString(),
      );
    const response = await postAdmin(
      `/approvals/${approvalId}/decision`,
      { decision: "approve" },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "DAILY_CAP_EXCEEDED" },
    });
    expect(provider.confirmCalls).toHaveLength(0);
  });

  it("expires pending approvals after 120 seconds", async () => {
    const approvalId = await requestApproval("pi_expiring");
    currentNow = new Date(FIXED_NOW.getTime() + 121_000);
    const { expirePendingApprovals } = await import("./admin.js");

    expect(expirePendingApprovals({ database, now: () => currentNow, events })).toBe(1);
    expect(
      (database
        .prepare("SELECT status, note FROM approvals WHERE id = ?")
        .get(approvalId) as { status: string; note: string }),
    ).toEqual({ status: "expired", note: "expired" });
    const status = await fetch(`${baseUrl}/v1/pay/pi_expiring`, {
      headers: { "X-Agent-Key": BUYER_KEY },
    });
    expect(await status.json()).toMatchObject({
      status: "rejected",
      reason: "APPROVAL_REJECTED",
    });
  });

  it("protects admin routes, applies mode and policy changes, and writes audit rows", async () => {
    expect((await postAdmin("/agents", undefined, "GET", "bad-key")).status).toBe(401);
    expect(await (await postAdmin("/mode", undefined, "GET")).json()).toEqual({
      mode: "guarded",
    });

    const mode = await postAdmin("/mode", { mode: "passthrough" }, "PUT");
    expect(mode.status).toBe(200);
    expect(await mode.json()).toEqual({ mode: "passthrough" });
    expect(await (await postAdmin("/mode", undefined, "GET")).json()).toEqual({
      mode: "passthrough",
    });

    const policy = await postAdmin(
      "/agents/agent_buyer_1/policy",
      {
        per_purchase_cap: 600,
        daily_cap: 800,
        approval_threshold: 350,
        velocity_max: 6,
        velocity_window_s: 15,
        allowed_sellers: ["seller_demo"],
        allowed_currencies: ["usd"],
      },
      "PUT",
    );
    expect(policy.status).toBe(200);

    const agents = await postAdmin("/agents", undefined, "GET");
    expect(await agents.json()).toMatchObject({
      mode: "passthrough",
      agents: [{ policy: { daily_cap: 800 } }],
    });
    expect(
      (database
        .prepare("SELECT event FROM audit_log ORDER BY id")
        .all() as Array<{ event: string }>).map(({ event }) => event),
    ).toEqual(["MODE_CHANGED", "POLICY_UPDATED"]);
  });

  it("authenticates, validates, and runs only whitelisted demo scenarios", async () => {
    expect((await fetch(`${baseUrl}/v1/admin/demo/runaway`, { method: "POST" })).status).toBe(401);
    expect((await postAdmin("/demo/not-a-scenario")).status).toBe(400);

    const observed: string[] = [];
    let resolveCompleted: () => void = () => undefined;
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    const unsubscribe = events.subscribe((name, payload) => {
      if (
        name === "demo_status" &&
        "status" in payload &&
        "scenario" in payload
      ) {
        observed.push(`${payload.status}:${payload.scenario}`);
        if (payload.status === "completed" && payload.scenario === "runaway_unguarded") {
          resolveCompleted();
        }
      }
    });
    try {
      const response = await postAdmin("/demo/runaway_unguarded");
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        status: "started",
        scenario: "runaway_unguarded",
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          completed,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("Demo did not complete")), 1000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      expect(demoScenarios).toEqual(["runaway"]);
      expect(observed).toContain("output:runaway_unguarded");
      expect(
        (database.prepare("SELECT value FROM settings WHERE key = 'policy_mode'").get() as { value: string }).value,
      ).toBe("guarded");
    } finally {
      unsubscribe();
    }
  });

  it("stops a running baseline demo, restores guarded mode, and reports cancellation", async () => {
    holdDemo = true;
    const observed: string[] = [];
    let resolveCancelled: () => void = () => undefined;
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });
    let cancellationTimeout: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = events.subscribe((name, payload) => {
      if (name === "demo_status" && "status" in payload) {
        observed.push(payload.status);
        if (payload.status === "cancelled") resolveCancelled();
      }
    });

    try {
      expect(
        (await fetch(`${baseUrl}/v1/admin/demo/stop`, { method: "POST" })).status,
      ).toBe(401);
      expect((await postAdmin("/demo/runaway_unguarded")).status).toBe(202);
      await demoStarted;
      expect(demoSignal?.aborted).toBe(false);
      expect(
        (database.prepare("SELECT value FROM settings WHERE key = 'policy_mode'").get() as { value: string }).value,
      ).toBe("passthrough");

      const stopResponse = await postAdmin("/demo/stop");
      expect(stopResponse.status).toBe(202);
      expect(await stopResponse.json()).toMatchObject({
        status: "stopping",
        scenario: "runaway_unguarded",
      });
      await Promise.race([
        cancelled,
        new Promise<never>((_resolve, reject) =>
          (cancellationTimeout = setTimeout(
            () => reject(new Error("Demo cancellation did not complete")),
            1000,
          )),
        ),
      ]);

      expect(demoSignal?.aborted).toBe(true);
      expect(observed).toContain("stopping");
      expect(observed).toContain("cancelled");
      expect(
        (database.prepare("SELECT value FROM settings WHERE key = 'policy_mode'").get() as { value: string }).value,
      ).toBe("guarded");
      expect((await postAdmin("/demo/stop")).status).toBe(409);
    } finally {
      unsubscribe();
      if (cancellationTimeout !== undefined) clearTimeout(cancellationTimeout);
    }
  });

  it("supports path-based approval approve and reject actions", async () => {
    const approvalId = await requestApproval("pi_path_approve");
    const rejected = await postAdmin(
      `/approvals/${approvalId}/reject`,
      { note: "Not approved" },
    );
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({ status: "rejected" });

    const secondApprovalId = await requestApproval("pi_path_approve_second");
    provider.intent = {
      id: "pi_path_approve_second",
      status: "requires_payment_method",
      amount: 400,
      currency: "usd",
      metadata: { seller_id: "seller_demo", resource_id: "premium-dataset" },
    };
    const approved = await postAdmin(
      `/approvals/${secondApprovalId}/approve`,
      { note: "Approved from updated dashboard" },
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ status: "approved" });
    const auditSearch = await postAdmin(
      "/audit?search=pi_path_approve_second",
      undefined,
      "GET",
    );
    const auditResult = await auditSearch.json() as {
      audit: Array<{ event: string; payment_intent_id: string | null }>;
    };
    expect(auditResult.audit).toContainEqual(
      expect.objectContaining({
        event: "APPROVED",
        payment_intent_id: "pi_path_approve_second",
      }),
    );
  });

  it("freezes and unfreezes through admin routes and publishes live events", async () => {
    const eventTypes: string[] = [];
    const unsubscribe = events.subscribe((name) => eventTypes.push(name));
    try {
      const freeze = await postAdmin("/agents/agent_buyer_1/freeze", { reason: "Operator pause" });
      expect(freeze.status).toBe(200);
      expect(await freeze.json()).toMatchObject({ frozen: true });

      const unfreeze = await postAdmin("/agents/agent_buyer_1/unfreeze");
      expect(unfreeze.status).toBe(200);
      expect(await unfreeze.json()).toMatchObject({ frozen: false });
    } finally {
      unsubscribe();
    }

    expect(eventTypes).toEqual(["agent_frozen", "agent_unfrozen"]);
  });

  it("lists approvals, transactions, and audit rows with bounded filters", async () => {
    await requestApproval();
    expect((await postAdmin("/approvals?status=pending", undefined, "GET")).status).toBe(200);
    const transactions = await postAdmin("/transactions?agent_id=agent_buyer_1&limit=1", undefined, "GET");
    expect((await transactions.json()).transactions).toHaveLength(1);
    const auditRows = await postAdmin("/audit?agent_id=agent_buyer_1&limit=20", undefined, "GET");
    expect((await auditRows.json()).audit.length).toBeGreaterThan(0);
    const searchedAudit = await postAdmin("/audit?search=pi_approval", undefined, "GET");
    const matchingAudit = await searchedAudit.json() as {
      audit: Array<{ payment_intent_id: string | null }>;
    };
    expect(matchingAudit.audit.length).toBeGreaterThan(0);
    expect(matchingAudit.audit[0].payment_intent_id).toBe("pi_approval");
    expect((await postAdmin("/transactions?limit=999", undefined, "GET")).status).toBe(400);
  });

  it("clears demo state but retains audit history; production reset is blocked", async () => {
    await postPayment();
    const reset = await postAdmin("/reset");
    expect(reset.status).toBe(200);
    expect(
      (database.prepare("SELECT COUNT(*) AS count FROM transactions").get() as { count: number }).count,
    ).toBe(0);
    expect(
      (database.prepare("SELECT event FROM audit_log ORDER BY id DESC LIMIT 1").get() as { event: string }).event,
    ).toBe("RESET");

    const prodAppServer = createServer(
      createGatewayApp({
        database,
        paymentProvider: provider,
        paymentMethod: PAYMENT_METHOD,
        adminKey: ADMIN_KEY,
        nodeEnv: "production",
        now: () => currentNow,
      }),
    );
    await new Promise<void>((resolve) => prodAppServer.listen(0, "127.0.0.1", resolve));
    const address = prodAppServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Production test server did not bind");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/admin/reset`, {
        method: "POST",
        headers: { "X-Admin-Key": ADMIN_KEY },
      });
      expect(response.status).toBe(403);
    } finally {
      prodAppServer.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        prodAppServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("streams admin-only SSE events", async () => {
    const unauthorized = await fetch(`${baseUrl}/v1/events`);
    expect(unauthorized.status).toBe(401);

    const controller = new AbortController();
    const streamResponse = await fetch(`${baseUrl}/v1/events`, {
      headers: { "X-Admin-Key": ADMIN_KEY },
      signal: controller.signal,
    });
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
    const reader = streamResponse.body?.getReader();
    if (!reader) {
      throw new Error("SSE response has no readable body");
    }
    try {
      await reader.read();
      await postPayment();
      let output = "";
      for (let index = 0; index < 3 && !output.includes("event: transaction"); index += 1) {
        const chunk = await reader.read();
        output += new TextDecoder().decode(chunk.value);
      }
      expect(output).toContain("event: transaction");
      expect(output).toContain('"payment_intent_id":"pi_test_1"');
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  });
});
