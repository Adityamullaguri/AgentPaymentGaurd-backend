import { describe, expect, it, vi } from "vitest";
import {
  runBuyerScenario,
  type BuyerConfig,
  type BuyerDependencies,
} from "./index.js";

const config: BuyerConfig = {
  sellerUrl: "http://seller.test",
  gatewayUrl: "http://gateway.test",
  agentId: "agent_buyer_1",
  agentKey: "test-agent-key",
};

function paymentRequired(
  resourceId = "market-prices",
  amount = 100,
  paymentIntentId = "pi_test",
): Response {
  return Response.json(
    {
      payment_required: {
        seller_id: "seller_demo",
        resource_id: resourceId,
        amount,
        currency: "usd",
        payment_intent_id: paymentIntentId,
        expires_at: "2026-11-03T12:30:00.000Z",
      },
    },
    { status: 402 },
  );
}

function dependencies(
  fetcher: typeof fetch,
  overrides: Partial<BuyerDependencies> = {},
): BuyerDependencies {
  return {
    fetch: fetcher,
    sleep: async () => undefined,
    now: () => 1_000,
    log: vi.fn(),
    retryBaseDelayMs: 10,
    pollIntervalMs: 10,
    ...overrides,
  };
}

describe("buyer CLI scenarios", () => {
  it("completes the 402, gateway payment, and seller delivery flow", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith(config.sellerUrl)) {
        return new Headers(init?.headers).has("X-Payment-Intent")
          ? Response.json({ resource_id: "market-prices", data: {} })
          : paymentRequired();
      }
      return Response.json({
        status: "paid",
        reason: "OK",
        payment_intent_id: "pi_test",
      });
    });

    const summary = await runBuyerScenario(
      "happy",
      config,
      dependencies(fetcher),
    );

    expect(summary).toMatchObject({
      purchases: 1,
      centsSpent: 100,
      stopReason: "SCENARIO_COMPLETED",
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({
      "X-Agent-Key": "test-agent-key",
    });
    expect(fetcher.mock.calls[2][1]?.headers).toMatchObject({
      "X-Payment-Intent": "pi_test",
    });
  });

  it("polls a large purchase until an operator approval is paid", async () => {
    let currentTime = 0;
    let polls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith(config.sellerUrl)) {
        return new Headers(init?.headers).has("X-Payment-Intent")
          ? Response.json({ resource_id: "premium-dataset", data: {} })
          : paymentRequired("premium-dataset", 400, "pi_approval");
      }
      if (url.endsWith("/v1/pay")) {
        return Response.json(
          { status: "pending_approval", approval_id: "apr_test" },
          { status: 202 },
        );
      }
      polls += 1;
      return Response.json(
        polls === 1
          ? { status: "pending_approval", reason: "APPROVAL_REQUIRED" }
          : { status: "paid", reason: "APPROVAL_REQUIRED" },
      );
    });

    const summary = await runBuyerScenario(
      "approval",
      config,
      dependencies(fetcher, {
        now: () => currentTime,
        sleep: async (milliseconds) => {
          currentTime += milliseconds;
        },
        maxPollDurationMs: 1_000,
      }),
    );

    expect(summary).toMatchObject({
      purchases: 1,
      centsSpent: 400,
      stopReason: "SCENARIO_COMPLETED",
    });
    expect(polls).toBe(2);
  });

  it("retries an unavailable seller three times and fails closed before payment", async () => {
    let currentTime = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error("connection refused");
    });
    const sleep = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });
    const log = vi.fn();

    const summary = await runBuyerScenario(
      "happy",
      config,
      dependencies(fetcher, { now: () => currentTime, sleep, log }),
    );

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      10,
      20,
    ]);
    expect(summary).toMatchObject({
      purchases: 0,
      centsSpent: 0,
      stopReason: "SELLER_UNAVAILABLE",
    });
    expect(log).toHaveBeenCalledWith(
      "SELLER_UNAVAILABLE: seller could not be reached after 3 attempts",
    );
  });

  it("aborts hung service requests so bounded retries can fail closed", async () => {
    const fetcher = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("request timed out")),
            { once: true },
          );
        }),
    );
    const summary = await runBuyerScenario(
      "happy",
      config,
      dependencies(fetcher, {
        requestTimeoutMs: 5,
        retryBaseDelayMs: 1,
      }),
    );

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({
      purchases: 0,
      centsSpent: 0,
      stopReason: "SELLER_UNAVAILABLE",
    });
  });

  it("retries an unavailable gateway three times and never requests paid seller data", async () => {
    let currentTime = 0;
    let sellerCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.startsWith(config.sellerUrl)) {
        sellerCalls += 1;
        return paymentRequired();
      }
      throw new Error("connection refused");
    });

    const summary = await runBuyerScenario(
      "happy",
      config,
      dependencies(fetcher, {
        now: () => currentTime,
        sleep: async (milliseconds) => {
          currentTime += milliseconds;
        },
      }),
    );

    expect(fetcher).toHaveBeenCalledTimes(7);
    expect(sellerCalls).toBe(1);
    expect(summary).toMatchObject({
      purchases: 0,
      centsSpent: 0,
      stopReason: "GATEWAY_UNAVAILABLE",
    });
  });

  it("checks transaction status after the gateway payment response is lost", async () => {
    let gatewayPostAttempts = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith(config.sellerUrl)) {
        return new Headers(init?.headers).has("X-Payment-Intent")
          ? Response.json({ resource_id: "market-prices", data: {} })
          : paymentRequired();
      }
      if (url.endsWith("/v1/pay")) {
        gatewayPostAttempts += 1;
        throw new Error("response lost after gateway accepted payment");
      }
      return Response.json({ status: "paid", reason: "OK" });
    });

    const summary = await runBuyerScenario(
      "happy",
      config,
      dependencies(fetcher),
    );

    expect(gatewayPostAttempts).toBe(3);
    expect(summary).toMatchObject({
      purchases: 1,
      centsSpent: 100,
      stopReason: "SCENARIO_COMPLETED",
    });
  });

  it("stops a runaway after the gateway refuses the sixth purchase", async () => {
    let paymentIntent = 0;
    let gatewayCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith(config.sellerUrl)) {
        if (new Headers(init?.headers).has("X-Payment-Intent")) {
          return Response.json({ resource_id: "market-prices", data: {} });
        }
        paymentIntent += 1;
        return paymentRequired(
          "market-prices",
          100,
          `pi_runaway_${paymentIntent}`,
        );
      }
      gatewayCalls += 1;
      return gatewayCalls <= 5
        ? Response.json({ status: "paid", reason: "OK" })
        : Response.json(
            {
              error: {
                code: "VELOCITY_LIMIT_EXCEEDED",
                message: "Too many purchases",
              },
            },
            { status: 403 },
          );
    });

    const summary = await runBuyerScenario(
      "runaway",
      config,
      dependencies(fetcher),
    );

    expect(summary).toMatchObject({
      purchases: 5,
      centsSpent: 500,
      stopReason: "VELOCITY_LIMIT_EXCEEDED",
    });
    expect(gatewayCalls).toBe(6);
  });
});
