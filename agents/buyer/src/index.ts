import { resolve, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "dotenv";

export type BuyerScenario = "happy" | "approval" | "runaway";

export interface BuyerConfig {
  sellerUrl: string;
  gatewayUrl: string;
  agentId: string;
  agentKey: string;
}

export interface BuyerSummary {
  purchases: number;
  centsSpent: number;
  stopReason: string;
  elapsedMs: number;
}

export interface BuyerDependencies {
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
  maxPollDurationMs?: number;
  pollIntervalMs?: number;
  retryBaseDelayMs?: number;
  requestTimeoutMs?: number;
}

interface PurchaseResult {
  delivered: boolean;
  paidCents: number;
  stopReason?: string;
}

interface PaymentTerms {
  seller_id: string;
  resource_id: string;
  amount: number;
  currency: string;
  payment_intent_id: string;
}

interface GatewayPayment {
  status?: string;
  reason?: string;
  approval_id?: string;
}

const RETRY_ATTEMPTS = 3;
const DEFAULT_MAX_POLL_DURATION_MS = 130_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePaymentTerms(value: unknown): PaymentTerms | undefined {
  if (!isRecord(value) || !isRecord(value.payment_required)) {
    return undefined;
  }
  const terms = value.payment_required;
  if (
    typeof terms.seller_id !== "string" ||
    typeof terms.resource_id !== "string" ||
    typeof terms.amount !== "number" ||
    !Number.isSafeInteger(terms.amount) ||
    terms.amount <= 0 ||
    typeof terms.currency !== "string" ||
    typeof terms.payment_intent_id !== "string" ||
    terms.payment_intent_id.length === 0
  ) {
    return undefined;
  }
  return {
    seller_id: terms.seller_id,
    resource_id: terms.resource_id,
    amount: terms.amount,
    currency: terms.currency,
    payment_intent_id: terms.payment_intent_id,
  };
}

function readErrorCode(value: unknown): string | undefined {
  return isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === "string"
    ? value.error.code
    : undefined;
}

async function requestWithRetry(
  url: string,
  init: RequestInit,
  dependencies: BuyerDependencies,
): Promise<Response | undefined> {
  const retryBaseDelayMs =
    dependencies.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const requestTimeoutMs =
    dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await dependencies.fetch(url, {
        ...init,
        signal: controller.signal,
      });
      if (response.status < 500 || attempt === RETRY_ATTEMPTS - 1) {
        return response.status >= 500 ? undefined : response;
      }
    } catch {
      if (attempt === RETRY_ATTEMPTS - 1) {
        return undefined;
      }
    } finally {
      clearTimeout(timeout);
    }
    await dependencies.sleep(retryBaseDelayMs * 2 ** attempt);
  }
  return undefined;
}

async function pollPayment(
  paymentIntentId: string,
  config: BuyerConfig,
  dependencies: BuyerDependencies,
): Promise<{ paid: boolean; reason: string }> {
  const startedAt = dependencies.now();
  const maxDuration =
    dependencies.maxPollDurationMs ?? DEFAULT_MAX_POLL_DURATION_MS;
  const pollInterval =
    dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  while (dependencies.now() - startedAt < maxDuration) {
    const response = await requestWithRetry(
      `${config.gatewayUrl}/v1/pay/${encodeURIComponent(paymentIntentId)}`,
      { headers: { "X-Agent-Key": config.agentKey } },
      dependencies,
    );
    if (!response) {
      dependencies.log(
        "GATEWAY_UNAVAILABLE: payment status could not be reached after 3 attempts",
      );
      return { paid: false, reason: "GATEWAY_UNAVAILABLE" };
    }
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      const reason = readErrorCode(body) ?? `GATEWAY_HTTP_${response.status}`;
      return { paid: false, reason };
    }

    const body: unknown = await response.json();
    const payment = body as GatewayPayment;
    if (payment.status === "paid") {
      return { paid: true, reason: payment.reason ?? "OK" };
    }
    if (
      payment.status === "failed" ||
      payment.status === "rejected" ||
      payment.status === "denied"
    ) {
      return { paid: false, reason: payment.reason ?? payment.status.toUpperCase() };
    }
    if (
      payment.status !== "processing" &&
      payment.status !== "pending_approval" &&
      payment.status !== "pending"
    ) {
      return { paid: false, reason: "INVALID_GATEWAY_RESPONSE" };
    }

    const remaining = maxDuration - (dependencies.now() - startedAt);
    if (remaining > 0) {
      await dependencies.sleep(Math.min(pollInterval, remaining));
    }
  }
  return { paid: false, reason: "APPROVAL_OR_PAYMENT_TIMEOUT" };
}

async function buyResource(
  resourceId: string,
  config: BuyerConfig,
  dependencies: BuyerDependencies,
): Promise<PurchaseResult> {
  const sellerUrl = `${config.sellerUrl}/v1/data/${encodeURIComponent(resourceId)}`;
  const sellerResponse = await requestWithRetry(sellerUrl, {}, dependencies);
  if (!sellerResponse) {
    dependencies.log("SELLER_UNAVAILABLE: seller could not be reached after 3 attempts");
    return { delivered: false, paidCents: 0, stopReason: "SELLER_UNAVAILABLE" };
  }
  if (sellerResponse.status !== 402) {
    return {
      delivered: false,
      paidCents: 0,
      stopReason:
        sellerResponse.status >= 400
          ? `SELLER_HTTP_${sellerResponse.status}`
          : "INVALID_SELLER_RESPONSE",
    };
  }

  const paymentTerms = parsePaymentTerms(await sellerResponse.json());
  if (!paymentTerms || paymentTerms.resource_id !== resourceId) {
    return {
      delivered: false,
      paidCents: 0,
      stopReason: "INVALID_PAYMENT_TERMS",
    };
  }

  const paymentResponse = await requestWithRetry(
    `${config.gatewayUrl}/v1/pay`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Key": config.agentKey,
      },
      body: JSON.stringify({
        agent_id: config.agentId,
        payment_intent_id: paymentTerms.payment_intent_id,
        seller_id: paymentTerms.seller_id,
        resource_id: paymentTerms.resource_id,
        amount: paymentTerms.amount,
        currency: paymentTerms.currency,
        purpose: `Buyer scenario purchase of ${resourceId}`,
      }),
    },
    dependencies,
  );
  if (!paymentResponse) {
    dependencies.log(
      "GATEWAY_UNAVAILABLE: payment response was unavailable after 3 attempts; checking transaction status",
    );
    const polled = await pollPayment(
      paymentTerms.payment_intent_id,
      config,
      dependencies,
    );
    if (!polled.paid) {
      return { delivered: false, paidCents: 0, stopReason: polled.reason };
    }
  }

  if (paymentResponse) {
    const paymentBody: unknown = await paymentResponse.json().catch(() => undefined);
    const errorCode = readErrorCode(paymentBody);
    const payment = paymentBody as GatewayPayment | undefined;
    if (
      paymentResponse.status !== 409 ||
      errorCode !== "DUPLICATE_PAYMENT_INTENT"
    ) {
      if (paymentResponse.status === 403 || !paymentResponse.ok) {
        return {
          delivered: false,
          paidCents: 0,
          stopReason: errorCode ?? `GATEWAY_HTTP_${paymentResponse.status}`,
        };
      }

      if (payment?.status !== "paid") {
        if (
          paymentResponse.status !== 202 &&
          payment?.status !== "processing" &&
          payment?.status !== "pending_approval"
        ) {
          return {
            delivered: false,
            paidCents: 0,
            stopReason:
              typeof payment?.reason === "string"
                ? payment.reason
                : "INVALID_GATEWAY_RESPONSE",
          };
        }
        const polled = await pollPayment(
          paymentTerms.payment_intent_id,
          config,
          dependencies,
        );
        if (!polled.paid) {
          return { delivered: false, paidCents: 0, stopReason: polled.reason };
        }
      }
    } else {
      const polled = await pollPayment(
        paymentTerms.payment_intent_id,
        config,
        dependencies,
      );
      if (!polled.paid) {
        return { delivered: false, paidCents: 0, stopReason: polled.reason };
      }
    }
  }

  const deliveryResponse = await requestWithRetry(
    sellerUrl,
    { headers: { "X-Payment-Intent": paymentTerms.payment_intent_id } },
    dependencies,
  );
  if (!deliveryResponse) {
    dependencies.log(
      "SELLER_UNAVAILABLE: payment succeeded but seller delivery failed after 3 attempts",
    );
    return {
      delivered: false,
      paidCents: paymentTerms.amount,
      stopReason: "SELLER_UNAVAILABLE",
    };
  }
  if (!deliveryResponse.ok) {
    const deliveryBody: unknown = await deliveryResponse.json().catch(() => undefined);
    return {
      delivered: false,
      paidCents: paymentTerms.amount,
      stopReason:
        readErrorCode(deliveryBody) ?? `SELLER_HTTP_${deliveryResponse.status}`,
    };
  }
  return { delivered: true, paidCents: paymentTerms.amount };
}

export async function runBuyerScenario(
  scenario: BuyerScenario,
  config: BuyerConfig,
  dependencies: BuyerDependencies,
): Promise<BuyerSummary> {
  const startedAt = dependencies.now();
  let purchases = 0;
  let centsSpent = 0;
  let stopReason = "SCENARIO_COMPLETED";
  const resources =
    scenario === "happy"
      ? ["market-prices"]
      : scenario === "approval"
        ? ["premium-dataset"]
        : Array.from({ length: 50 }, () => "market-prices");

  for (const resource of resources) {
    const result = await buyResource(resource, config, dependencies);
    centsSpent += result.paidCents;
    if (result.delivered) {
      purchases += 1;
      continue;
    }
    stopReason = result.stopReason ?? "PURCHASE_FAILED";
    break;
  }

  return {
    purchases,
    centsSpent,
    stopReason,
    elapsedMs: Math.max(0, dependencies.now() - startedAt),
  };
}

export function loadBuyerConfig(): BuyerConfig {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const envPath = resolve(projectRoot, ".env");
  const allowedNames = new Set([
    "BUYER_AGENT_KEY",
    "BUYER_AGENT_ID",
    "SELLER_URL",
    "GATEWAY_URL",
  ]);
  const fileConfig = existsSync(envPath)
    ? parse(
        readFileSync(envPath, "utf8")
          .split(/\r?\n/)
          .filter((line) => {
            const assignment = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
            return assignment !== null && allowedNames.has(assignment[1]);
          })
          .join("\n"),
      )
    : {};
  const configuredValue = (name: string): string | undefined =>
    process.env[name] ?? fileConfig[name];
  const agentKey = configuredValue("BUYER_AGENT_KEY")?.trim();
  if (!agentKey || agentKey.toLowerCase().startsWith("replace_with_")) {
    throw new Error("BUYER_AGENT_KEY must be configured in the root .env file");
  }
  return {
    sellerUrl: (configuredValue("SELLER_URL") ?? "http://localhost:4001").replace(
      /\/+$/,
      "",
    ),
    gatewayUrl: (configuredValue("GATEWAY_URL") ?? "http://localhost:4002").replace(
      /\/+$/,
      "",
    ),
    agentId: configuredValue("BUYER_AGENT_ID")?.trim() || "agent_buyer_1",
    agentKey,
  };
}

export async function main(
  scenarioName = process.argv[2],
): Promise<void> {
  if (
    scenarioName !== "happy" &&
    scenarioName !== "approval" &&
    scenarioName !== "runaway"
  ) {
    throw new Error("Usage: npm run buyer -- <happy|approval|runaway>");
  }

  const config = loadBuyerConfig();
  const dependencies: BuyerDependencies = {
    fetch,
    sleep: (milliseconds) =>
      new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
    now: Date.now,
    log: console.log,
  };
  const summary = await runBuyerScenario(scenarioName, config, dependencies);
  console.log(
    `SUMMARY purchases=${summary.purchases} cents_spent=${summary.centsSpent} stop_reason=${summary.stopReason} elapsed_ms=${summary.elapsedMs}`,
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entryPoint === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(
      `BUYER_FAILED: ${error instanceof Error ? error.message : "Unexpected error"}`,
    );
    process.exitCode = 1;
  });
}
