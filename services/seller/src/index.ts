import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import Stripe from "stripe";
import { initializeSellerDatabase } from "./database.js";
import {
  createSellerApp,
  type PaymentIntentDetails,
  type PaymentProvider,
} from "./seller.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: resolve(projectRoot, ".env") });

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey?.startsWith("sk_test_")) {
  throw new Error("Seller requires STRIPE_SECRET_KEY to be a Stripe test-mode key (sk_test_...)");
}

const stripe = new Stripe(secretKey);
const paymentProvider: PaymentProvider = {
  async createPaymentIntent(input) {
    const intent = await stripe.paymentIntents.create(input);
    return {
      id: intent.id,
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
      metadata: intent.metadata,
    };
  },
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
};

const database = new Database(resolve(projectRoot, "seller.db"));
const currency = process.env.CURRENCY?.trim().toLowerCase() || "usd";
initializeSellerDatabase(database, currency);

const port = Number.parseInt(process.env.SELLER_PORT ?? "4001", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("SELLER_PORT must be a valid TCP port");
}

const app = createSellerApp({ database, paymentProvider });
app.listen(port, () => {
  console.log(`Seller listening on port ${port}`);
});
