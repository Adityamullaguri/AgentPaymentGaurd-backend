import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import Stripe from "stripe";
import { initializeGatewayDatabase } from "./database.js";
import { expirePendingApprovals } from "./admin.js";
import { GatewayEventHub } from "./events.js";
import {
  createGatewayApp,
  type GatewayPaymentProvider,
} from "./pay.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: resolve(projectRoot, ".env") });

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey?.startsWith("sk_test_")) {
  throw new Error(
    "Gateway requires STRIPE_SECRET_KEY to be a Stripe test-mode key (sk_test_...)",
  );
}

const paymentMethod = process.env.STRIPE_TEST_PAYMENT_METHOD?.trim();
if (!paymentMethod?.startsWith("pm_")) {
  throw new Error(
    "STRIPE_TEST_PAYMENT_METHOD must be a Stripe test PaymentMethod id (pm_...)",
  );
}

const buyerAgentKey = process.env.BUYER_AGENT_KEY?.trim();
const adminKey = process.env.ADMIN_KEY?.trim();
if (!buyerAgentKey || buyerAgentKey.toLowerCase().startsWith("replace_with_")) {
  throw new Error("BUYER_AGENT_KEY must be configured with a non-placeholder value");
}
if (!adminKey || adminKey.toLowerCase().startsWith("replace_with_")) {
  throw new Error("ADMIN_KEY must be configured with a non-placeholder value");
}

const policyMode = process.env.POLICY_MODE ?? "guarded";
if (policyMode !== "guarded" && policyMode !== "passthrough") {
  throw new Error("POLICY_MODE must be 'guarded' or 'passthrough'");
}
const currency = process.env.CURRENCY?.trim().toLowerCase() || "usd";
if (!/^[a-z]{3}$/.test(currency)) {
  throw new Error("CURRENCY must be a three-letter currency code");
}

const stripe = new Stripe(stripeSecretKey);
const paymentProvider: GatewayPaymentProvider = {
  async retrievePaymentIntent(id) {
    const intent = await stripe.paymentIntents.retrieve(id);
    return {
      id: intent.id,
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
      metadata: intent.metadata,
    };
  },
  async confirmPaymentIntent(id, method) {
    const intent = await stripe.paymentIntents.confirm(id, {
      payment_method: method,
    });
    return {
      id: intent.id,
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
      metadata: intent.metadata,
    };
  },
};

const database = new Database(resolve(projectRoot, "gateway.db"));
initializeGatewayDatabase(database, {
  buyerAgentKey,
  currency,
  policyMode,
});
const events = new GatewayEventHub();

const port = Number.parseInt(process.env.GATEWAY_PORT ?? "4002", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("GATEWAY_PORT must be a valid TCP port");
}

const app = createGatewayApp({
  database,
  paymentProvider,
  paymentMethod,
  adminKey,
  events,
  projectRoot,
});
const server = app.listen(port, () => {
  console.log(`Gateway listening on port ${port}`);
});
const approvalSweeper = setInterval(() => {
  try {
    expirePendingApprovals({ database, now: () => new Date(), events });
  } catch (error) {
    console.error("Approval expiry sweep failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }
}, 1_000);
approvalSweeper.unref();

function shutdown(): void {
  clearInterval(approvalSweeper);
  server.close((error) => {
    database.close();
    if (error) {
      console.error("Gateway shutdown failed", { errorType: error.name });
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
