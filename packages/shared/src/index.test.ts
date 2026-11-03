import { describe, expect, it } from "vitest";
import { payRequestSchema } from "./index.js";

describe("payRequestSchema", () => {
  it("accepts a valid payment request", () => {
    expect(
      payRequestSchema.safeParse({
        agent_id: "agent_buyer_1",
        payment_intent_id: "pi_test",
        seller_id: "seller_demo",
        resource_id: "market-prices",
        amount: 100,
        currency: "usd",
        purpose: "Price a basket",
      }).success,
    ).toBe(true);
  });

  it("rejects fractional and non-positive amounts", () => {
    const request = {
      agent_id: "agent_buyer_1",
      payment_intent_id: "pi_test",
      seller_id: "seller_demo",
      resource_id: "market-prices",
      currency: "usd",
      purpose: "Price a basket",
    };

    expect(payRequestSchema.safeParse({ ...request, amount: 1.5 }).success).toBe(false);
    expect(payRequestSchema.safeParse({ ...request, amount: 0 }).success).toBe(false);
  });
});
