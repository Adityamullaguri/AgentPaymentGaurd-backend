import { randomUUID } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type Database from "better-sqlite3";

const SELLER_ID = "seller_demo";
const OFFER_TTL_MS = 15 * 60 * 1000;

export interface PaymentIntentDetails {
  id: string;
  status: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
}

export interface PaymentProvider {
  createPaymentIntent(input: {
    amount: number;
    currency: string;
    confirm: false;
    automatic_payment_methods: {
      enabled: true;
      allow_redirects: "never";
    };
    metadata: {
      seller_id: string;
      resource_id: string;
    };
  }): Promise<PaymentIntentDetails>;
  retrievePaymentIntent(id: string): Promise<PaymentIntentDetails>;
}

interface ResourceRow {
  id: string;
  title: string;
  price: number;
  currency: string;
  payload: string;
}

interface OfferRow {
  payment_intent_id: string;
  resource_id: string;
  amount: number;
  currency: string;
  status: "pending" | "redeemed" | "expired";
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
}

interface SellerDependencies {
  database: Database.Database;
  paymentProvider: PaymentProvider;
  now?: () => Date;
}

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

export function createSellerApp({
  database,
  paymentProvider,
  now = () => new Date(),
}: SellerDependencies): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/v1/data/:resourceId", asyncHandler(async (req, res) => {
    const resource = database
      .prepare("SELECT id, title, price, currency, payload FROM resources WHERE id = ?")
      .get(req.params.resourceId) as ResourceRow | undefined;

    if (!resource) {
      sendError(res, 404, "RESOURCE_NOT_FOUND", "The requested resource does not exist");
      return;
    }

    const requestedIntentId = req.header("X-Payment-Intent");
    if (!requestedIntentId) {
      await createOffer(resource, database, paymentProvider, now, res);
      return;
    }

    const offer = database
      .prepare("SELECT * FROM offers WHERE payment_intent_id = ?")
      .get(requestedIntentId) as OfferRow | undefined;

    if (!offer || offer.resource_id !== resource.id) {
      await createOffer(resource, database, paymentProvider, now, res);
      return;
    }

    if (offer.status === "redeemed") {
      sendError(res, 409, "ALREADY_REDEEMED", "This payment intent has already been redeemed");
      return;
    }

    if (offer.status === "expired" || new Date(offer.expires_at).getTime() <= now().getTime()) {
      database
        .prepare("UPDATE offers SET status = 'expired' WHERE payment_intent_id = ?")
        .run(offer.payment_intent_id);
      await createOffer(resource, database, paymentProvider, now, res);
      return;
    }

    let paymentIntent: PaymentIntentDetails;
    try {
      paymentIntent = await paymentProvider.retrievePaymentIntent(offer.payment_intent_id);
    } catch (error) {
      console.error("Seller Stripe PaymentIntent lookup failed", {
        errorType: errorType(error),
      });
      sendError(res, 502, "PAYMENT_PROVIDER_ERROR", "Could not verify the payment");
      return;
    }

    if (
      paymentIntent.id !== offer.payment_intent_id ||
      paymentIntent.amount !== offer.amount ||
      paymentIntent.currency.toLowerCase() !== offer.currency.toLowerCase()
    ) {
      sendError(res, 402, "PAYMENT_MISMATCH", "Payment amount or currency does not match the offer");
      return;
    }

    if (paymentIntent.status !== "succeeded") {
      sendPaymentRequired(res, offer, resource);
      return;
    }

    const data: unknown = JSON.parse(resource.payload);
    const redemption = database.transaction(() => {
      const currentTime = now().toISOString();
      const updated = database
        .prepare(
          `UPDATE offers
           SET status = 'redeemed', redeemed_at = ?
           WHERE payment_intent_id = ? AND status = 'pending' AND expires_at > ?`,
        )
        .run(currentTime, offer.payment_intent_id, currentTime);
      if (updated.changes === 1) {
        return "redeemed" as const;
      }

      const currentOffer = database
        .prepare("SELECT status, expires_at FROM offers WHERE payment_intent_id = ?")
        .get(offer.payment_intent_id) as
        | { status: OfferRow["status"]; expires_at: string }
        | undefined;
      if (currentOffer?.status === "pending" && currentOffer.expires_at <= currentTime) {
        database
          .prepare(
            "UPDATE offers SET status = 'expired' WHERE payment_intent_id = ? AND status = 'pending'",
          )
          .run(offer.payment_intent_id);
        return "expired" as const;
      }
      return currentOffer?.status === "redeemed"
        ? "already_redeemed" as const
        : "unavailable" as const;
    })();

    if (redemption !== "redeemed") {
      if (redemption === "already_redeemed") {
        sendError(res, 409, "ALREADY_REDEEMED", "This payment intent has already been redeemed");
        return;
      }
      if (redemption === "expired") {
        await createOffer(resource, database, paymentProvider, now, res);
        return;
      }
      sendError(res, 402, "PAYMENT_REQUIRED", "This payment offer is no longer available");
      return;
    }

    res.json({
      resource_id: resource.id,
      data,
      receipt_id: `rcpt_${randomUUID()}`,
    });
  }));

  app.use((_req, res) => {
    sendError(res, 404, "NOT_FOUND", "The requested endpoint does not exist");
  });

  const handleError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 400
        ? 400
        : 500;
    if (status === 500) {
      console.error("Seller request failed", { errorType: errorType(error) });
    }
    sendError(
      res,
      status,
      status === 400 ? "INVALID_REQUEST" : "INTERNAL_ERROR",
      status === 400 ? "The request could not be parsed" : "The seller could not process the request",
    );
  };
  app.use(handleError);

  return app;
}

async function createOffer(
  resource: ResourceRow,
  database: Database.Database,
  paymentProvider: PaymentProvider,
  now: () => Date,
  res: Response,
): Promise<void> {
  let paymentIntent: PaymentIntentDetails;
  try {
    paymentIntent = await paymentProvider.createPaymentIntent({
      amount: resource.price,
      currency: resource.currency,
      confirm: false,
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: "never",
      },
      metadata: {
        seller_id: SELLER_ID,
        resource_id: resource.id,
      },
    });
  } catch (error) {
    console.error("Seller could not create Stripe PaymentIntent", {
      errorType: errorType(error),
    });
    sendError(res, 502, "PAYMENT_PROVIDER_ERROR", "Could not create a payment offer");
    return;
  }

  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + OFFER_TTL_MS);
  database
    .prepare(
      `INSERT INTO offers
       (payment_intent_id, resource_id, amount, currency, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      paymentIntent.id,
      resource.id,
      resource.price,
      resource.currency,
      createdAt.toISOString(),
      expiresAt.toISOString(),
    );
  sendPaymentRequired(
    res,
    {
      payment_intent_id: paymentIntent.id,
      resource_id: resource.id,
      amount: resource.price,
      currency: resource.currency,
      expires_at: expiresAt.toISOString(),
    },
    resource,
  );
}

function sendPaymentRequired(
  res: Response,
  offer: Pick<OfferRow, "payment_intent_id" | "resource_id" | "amount" | "currency" | "expires_at">,
  resource: ResourceRow,
): void {
  res.setHeader("WWW-Authenticate", `Payment intent="${offer.payment_intent_id}"`);
  res.status(402).json({
    payment_required: {
      seller_id: SELLER_ID,
      resource_id: resource.id,
      amount: offer.amount,
      currency: offer.currency,
      payment_intent_id: offer.payment_intent_id,
      expires_at: offer.expires_at,
    },
  });
}
