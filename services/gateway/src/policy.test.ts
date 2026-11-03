import { describe, expect, it } from "vitest";
import type { PayRequest, PolicyConfig } from "@agentpay/shared";
import { evaluatePolicy, type PolicyState } from "./policy.js";

const now = new Date("2026-11-03T12:00:00.000Z");
const request: PayRequest = {
  agent_id: "agent_buyer_1",
  payment_intent_id: "pi_test",
  seller_id: "seller_demo",
  resource_id: "market-prices",
  amount: 100,
  currency: "usd",
  purpose: "Price a basket",
};
const config: PolicyConfig = {
  per_purchase_cap: 500,
  daily_cap: 500,
  approval_threshold: 300,
  velocity_max: 5,
  velocity_window_s: 10,
  allowed_sellers: ["seller_demo"],
  allowed_currencies: ["usd"],
  auto_freeze_on_velocity: true,
};

function policyState(overrides: Partial<PolicyState> = {}): PolicyState {
  return {
    agent: { id: "agent_buyer_1", frozen: false },
    spent_today: 0,
    pending_today: 0,
    recent_purchase_times: [],
    known_payment_intent: false,
    ...overrides,
  };
}

describe("evaluatePolicy", () => {
  it("allows a normal purchase", () => {
    expect(evaluatePolicy({ request, now }, policyState(), config)).toMatchObject({
      decision: "allow",
      reason: "OK",
    });
  });

  it("blocks a duplicate intent", () => {
    expect(
      evaluatePolicy({ request, now }, policyState({ known_payment_intent: true }), config),
    ).toMatchObject({ decision: "deny", reason: "DUPLICATE_PAYMENT_INTENT" });
  });

  it("blocks a frozen agent", () => {
    expect(
      evaluatePolicy(
        { request, now },
        policyState({ agent: { id: "agent_buyer_1", frozen: true } }),
        config,
      ),
    ).toMatchObject({ decision: "deny", reason: "AGENT_FROZEN" });
  });

  it("blocks a disallowed currency", () => {
    expect(
      evaluatePolicy({ request: { ...request, currency: "eur" }, now }, policyState(), config),
    ).toMatchObject({ decision: "deny", reason: "CURRENCY_NOT_ALLOWED" });
  });

  it("blocks an unknown seller", () => {
    expect(
      evaluatePolicy(
        { request: { ...request, seller_id: "seller_evil" }, now },
        policyState(),
        config,
      ),
    ).toMatchObject({ decision: "deny", reason: "SELLER_NOT_ALLOWED" });
  });

  it("trips the velocity breaker for five purchases in the window", () => {
    const recent_purchase_times = Array.from(
      { length: 5 },
      (_, index) => new Date(now.getTime() - index * 1000),
    );
    expect(
      evaluatePolicy({ request, now }, policyState({ recent_purchase_times }), config),
    ).toMatchObject({
      decision: "deny",
      reason: "VELOCITY_LIMIT_EXCEEDED",
      freeze_agent: true,
    });
  });

  it("blocks a purchase over the per-purchase cap", () => {
    expect(
      evaluatePolicy({ request: { ...request, amount: 501 }, now }, policyState(), config),
    ).toMatchObject({ decision: "deny", reason: "PER_PURCHASE_CAP_EXCEEDED" });
  });

  it("allows a purchase exactly at the daily cap", () => {
    expect(
      evaluatePolicy({ request, now }, policyState({ spent_today: 400 }), config),
    ).toMatchObject({ decision: "allow", reason: "OK" });
  });

  it("blocks a purchase over the daily cap", () => {
    expect(
      evaluatePolicy({ request, now }, policyState({ spent_today: 450 }), config),
    ).toMatchObject({ decision: "deny", reason: "DAILY_CAP_EXCEEDED" });
  });

  it("counts pending approvals toward the daily cap", () => {
    expect(
      evaluatePolicy(
        { request, now },
        policyState({ spent_today: 300, pending_today: 150 }),
        config,
      ),
    ).toMatchObject({ decision: "deny", reason: "DAILY_CAP_EXCEEDED" });
  });

  it("requires approval above the approval threshold", () => {
    expect(
      evaluatePolicy({ request: { ...request, amount: 400 }, now }, policyState(), config),
    ).toMatchObject({ decision: "needs_approval", reason: "APPROVAL_REQUIRED" });
  });

  it("allows a purchase exactly at the approval threshold", () => {
    expect(
      evaluatePolicy({ request: { ...request, amount: 300 }, now }, policyState(), config),
    ).toMatchObject({ decision: "allow", reason: "OK" });
  });

  it("checks the kill switch before monetary caps", () => {
    expect(
      evaluatePolicy(
        { request: { ...request, amount: 501 }, now },
        policyState({ agent: { id: "agent_buyer_1", frozen: true } }),
        config,
      ),
    ).toMatchObject({ decision: "deny", reason: "AGENT_FROZEN" });
  });
});
