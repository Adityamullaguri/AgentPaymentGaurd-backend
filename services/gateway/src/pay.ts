import { randomUUID, timingSafeEqual } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type Database from "better-sqlite3";
import { payRequestSchema, type PayRequest, type PolicyConfig } from "@agentpay/shared";
import {
  createAdminRouter,
  registerAdminEvents,
  type DemoRunner,
} from "./admin.js";
import { hashApiKey } from "./database.js";
import { GatewayEventHub } from "./events.js";
import { recoverPaymentIntent } from "./payment-reconciliation.js";
import { evaluatePolicy, type PolicyResult, type PolicyState } from "./policy.js";

export interface GatewayPaymentIntent {
  id: string;
  status: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
}

export interface GatewayPaymentProvider {
  retrievePaymentIntent(id: string): Promise<GatewayPaymentIntent>;
  confirmPaymentIntent(
    id: string,
    paymentMethod: string,
  ): Promise<GatewayPaymentIntent>;
}

interface AgentRow {
  id: string;
  api_key_hash: string;
  frozen: number;
  frozen_reason: string | null;
}

interface PolicyRow extends Omit<PolicyConfig, "allowed_sellers" | "allowed_currencies" | "auto_freeze_on_velocity"> {
  allowed_sellers: string;
  allowed_currencies: string;
  auto_freeze_on_velocity: number;
}

interface TransactionRow {
  id: string;
  agent_id: string;
  payment_intent_id: string;
  amount: number;
  status: "processing" | "succeeded" | "pending_approval" | "denied" | "rejected" | "failed";
  reason: string;
}

interface GatewayDependencies {
  database: Database.Database;
  paymentProvider: GatewayPaymentProvider;
  paymentMethod: string;
  adminKey?: string;
  events?: GatewayEventHub;
  nodeEnv?: string;
  now?: () => Date;
  projectRoot?: string;
  demoRunner?: DemoRunner;
}

interface DecisionRecord {
  transactionId: string;
  approvalId?: string;
  result: PolicyResult;
  mode: "guarded" | "passthrough";
}

function errorResponse(
  res: Response,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ error: { code, message } });
}

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function safeCompareHash(apiKey: string, expectedHash: string): boolean {
  const providedHash = Buffer.from(hashApiKey(apiKey), "hex");
  const storedHash = Buffer.from(expectedHash, "hex");
  return (
    providedHash.length === storedHash.length &&
    timingSafeEqual(providedHash, storedHash)
  );
}

function readPolicy(row: PolicyRow): PolicyConfig {
  return {
    per_purchase_cap: row.per_purchase_cap,
    daily_cap: row.daily_cap,
    approval_threshold: row.approval_threshold,
    velocity_max: row.velocity_max,
    velocity_window_s: row.velocity_window_s,
    allowed_sellers: JSON.parse(row.allowed_sellers) as string[],
    allowed_currencies: JSON.parse(row.allowed_currencies) as string[],
    auto_freeze_on_velocity: row.auto_freeze_on_velocity === 1,
  };
}

function policyState(
  database: Database.Database,
  agent: AgentRow,
  request: PayRequest,
  now: Date,
): { state: PolicyState; config: PolicyConfig } {
  const policy = database
    .prepare("SELECT * FROM policies WHERE agent_id = ?")
    .get(agent.id) as PolicyRow | undefined;
  if (!policy) {
    throw new Error(`Policy is missing for agent ${agent.id}`);
  }

  const utcDay = now.toISOString().slice(0, 10);
  const totals = database
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'succeeded' THEN amount ELSE 0 END), 0) AS spent_today,
         COALESCE(SUM(CASE WHEN status IN ('pending_approval', 'processing') THEN amount ELSE 0 END), 0) AS pending_today
       FROM transactions
       WHERE agent_id = ? AND substr(created_at, 1, 10) = ?`,
    )
    .get(agent.id, utcDay) as { spent_today: number; pending_today: number };
  const windowStart = new Date(
    now.getTime() - policy.velocity_window_s * 1000,
  ).toISOString();
  const recentRows = database
    .prepare(
      `SELECT created_at FROM transactions
       WHERE agent_id = ?
         AND created_at >= ?
         AND status IN ('processing', 'succeeded', 'pending_approval')`,
    )
    .all(agent.id, windowStart) as Array<{ created_at: string }>;
  const knownPaymentIntent = Boolean(
    database
      .prepare("SELECT 1 FROM transactions WHERE payment_intent_id = ?")
      .get(request.payment_intent_id),
  );

  return {
    state: {
      agent: { id: agent.id, frozen: agent.frozen === 1 },
      spent_today: totals.spent_today,
      pending_today: totals.pending_today,
      recent_purchase_times: recentRows.map((row) => new Date(row.created_at)),
      known_payment_intent: knownPaymentIntent,
    },
    config: readPolicy(policy),
  };
}

function writeAudit(
  database: Database.Database,
  input: {
    ts: string;
    agentId: string;
    event: string;
    reason: string;
    amount: number;
    refId: string;
    detail: unknown;
  },
): void {
  database
    .prepare(
      `INSERT INTO audit_log (ts, agent_id, event, reason, amount, ref_id, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.ts,
      input.agentId,
      input.event,
      input.reason,
      input.amount,
      input.refId,
      JSON.stringify(input.detail),
    );
}

function authenticateRequest(
  req: Request,
  database: Database.Database,
  agentId: string,
): AgentRow | undefined {
  const apiKey = req.header("X-Agent-Key");
  if (!apiKey) {
    return undefined;
  }
  const agent = database
    .prepare("SELECT id, api_key_hash, frozen, frozen_reason FROM agents WHERE id = ?")
    .get(agentId) as AgentRow | undefined;
  if (!agent || !safeCompareHash(apiKey, agent.api_key_hash)) {
    return undefined;
  }
  return agent;
}

function authenticateAdmin(
  req: Request,
  adminKey: string | undefined,
): boolean {
  const provided = req.header("X-Admin-Key");
  if (!adminKey || !provided) {
    return false;
  }
  return safeCompareHash(provided, hashApiKey(adminKey));
}

export function createGatewayApp({
  database,
  paymentProvider,
  paymentMethod,
  adminKey,
  events = new GatewayEventHub(),
  nodeEnv = process.env.NODE_ENV ?? "development",
  now = () => new Date(),
  projectRoot = process.cwd(),
  demoRunner,
}: GatewayDependencies): express.Express {
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  if (adminKey) {
    app.use(
      "/v1/admin",
      createAdminRouter({
        database,
        adminKey,
        paymentProvider,
        paymentMethod,
        events,
        now,
        nodeEnv,
        projectRoot,
        demoRunner,
      }),
    );
    registerAdminEvents(app, adminKey, events);
  }

  app.get("/health", (_req, res) => {
    const mode = database
      .prepare("SELECT value FROM settings WHERE key = 'policy_mode'")
      .get() as { value: string } | undefined;
    res.json({ ok: true, mode: mode?.value ?? "guarded" });
  });

  app.post("/v1/pay", asyncHandler(async (req, res) => {
    const parsedRequest = payRequestSchema.safeParse(req.body);
    if (!parsedRequest.success) {
      errorResponse(res, 422, "INVALID_REQUEST", "The payment request is invalid");
      return;
    }

    const request: PayRequest = {
      ...parsedRequest.data,
      currency: parsedRequest.data.currency.toLowerCase(),
    };
    const agent = authenticateRequest(req, database, request.agent_id);
    if (!agent) {
      errorResponse(res, 401, "BAD_AGENT_KEY", "The agent key is invalid");
      return;
    }

    const decisionRecord = database.transaction((): DecisionRecord => {
      const currentTime = now();
      const timestamp = currentTime.toISOString();
      const currentAgent = database
        .prepare("SELECT id, api_key_hash, frozen, frozen_reason FROM agents WHERE id = ?")
        .get(agent.id) as AgentRow | undefined;
      if (!currentAgent) {
        throw new Error(`Authenticated agent ${agent.id} disappeared`);
      }
      const modeRow = database
        .prepare("SELECT value FROM settings WHERE key = 'policy_mode'")
        .get() as { value: string } | undefined;
      const mode = modeRow?.value === "passthrough" ? "passthrough" : "guarded";

      const alreadyUsed = Boolean(
        database
          .prepare("SELECT 1 FROM transactions WHERE payment_intent_id = ?")
          .get(request.payment_intent_id),
      );
      if (alreadyUsed) {
        writeAudit(database, {
          ts: timestamp,
          agentId: agent.id,
          event: "DENIED",
          reason: "DUPLICATE_PAYMENT_INTENT",
          amount: request.amount,
          refId: request.payment_intent_id,
          detail: {
            message: `Payment intent ${request.payment_intent_id} has already been used`,
            mode,
          },
        });
        return {
          transactionId: "",
          result: {
            decision: "deny",
            reason: "DUPLICATE_PAYMENT_INTENT",
            message: `Payment intent ${request.payment_intent_id} has already been used`,
          },
          mode,
        };
      }

      let policyResult: PolicyResult;
      let state: PolicyState | undefined;
      let config: PolicyConfig | undefined;
      if (mode === "passthrough") {
        policyResult = {
          decision: "allow",
          reason: "OK",
          message: "Policy bypassed in passthrough mode",
        };
      } else {
        const loaded = policyState(database, currentAgent, request, currentTime);
        state = loaded.state;
        config = loaded.config;
        policyResult = evaluatePolicy(
          { request, now: currentTime },
          state,
          config,
        );
      }

      const transactionId = `txn_${randomUUID()}`;
      const status =
        policyResult.decision === "allow"
          ? "processing"
          : policyResult.decision === "needs_approval"
            ? "pending_approval"
            : "denied";
      database
        .prepare(
          `INSERT INTO transactions
           (id, agent_id, payment_intent_id, seller_id, resource_id, amount, currency,
            purpose, status, decision, reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          transactionId,
          agent.id,
          request.payment_intent_id,
          request.seller_id,
          request.resource_id,
          request.amount,
          request.currency,
          request.purpose,
          status,
          policyResult.decision,
          policyResult.reason,
          timestamp,
          timestamp,
        );

      const approvalId =
        policyResult.decision === "needs_approval"
          ? `apr_${randomUUID()}`
          : undefined;
      if (approvalId) {
        database
          .prepare(
            `INSERT INTO approvals
             (id, transaction_id, agent_id, amount, status, requested_at)
             VALUES (?, ?, ?, ?, 'pending', ?)`,
          )
          .run(approvalId, transactionId, agent.id, request.amount, timestamp);
      }

      const event =
        policyResult.decision === "allow"
          ? "ALLOWED"
          : policyResult.decision === "needs_approval"
            ? "NEEDS_APPROVAL"
            : "DENIED";
      writeAudit(database, {
        ts: timestamp,
        agentId: agent.id,
        event,
        reason: policyResult.reason,
        amount: request.amount,
        refId: transactionId,
        detail: {
          message: policyResult.message,
          mode,
          spent_today: state?.spent_today ?? 0,
          pending_today: state?.pending_today ?? 0,
          daily_cap: config?.daily_cap ?? null,
          per_purchase_cap: config?.per_purchase_cap ?? null,
          approval_threshold: config?.approval_threshold ?? null,
          recent_purchases: state?.recent_purchase_times.length ?? 0,
        },
      });

      if (policyResult.freeze_agent) {
        database
          .prepare(
            "UPDATE agents SET frozen = 1, frozen_reason = ? WHERE id = ?",
          )
          .run(policyResult.message, agent.id);
        writeAudit(database, {
          ts: timestamp,
          agentId: agent.id,
          event: "FROZEN",
          reason: policyResult.reason,
          amount: request.amount,
          refId: transactionId,
          detail: { message: policyResult.message },
        });
      }

      return { transactionId, approvalId, result: policyResult, mode };
    })();

    if (decisionRecord.result.reason === "DUPLICATE_PAYMENT_INTENT") {
      errorResponse(
        res,
        409,
        decisionRecord.result.reason,
        decisionRecord.result.message,
      );
      return;
    }

    const eventTimestamp = now().toISOString();
    const transactionEvent = {
      id: decisionRecord.transactionId,
      agent_id: agent.id,
      payment_intent_id: request.payment_intent_id,
      seller_id: request.seller_id,
      resource_id: request.resource_id,
      amount: request.amount,
      status:
        decisionRecord.result.decision === "allow"
          ? "processing"
          : decisionRecord.result.decision === "needs_approval"
            ? "pending_approval"
            : "denied",
      decision: decisionRecord.result.decision,
      reason: decisionRecord.result.reason,
      created_at: eventTimestamp,
    };
    events.publish("transaction", transactionEvent);
    if (decisionRecord.approvalId) {
      events.publish("approval_requested", {
        approval_id: decisionRecord.approvalId,
        transaction_id: decisionRecord.transactionId,
        agent_id: agent.id,
        seller_id: request.seller_id,
        resource_id: request.resource_id,
        amount: request.amount,
        purpose: request.purpose,
        requested_at: eventTimestamp,
      });
    }
    if (decisionRecord.result.freeze_agent) {
      events.publish("agent_frozen", {
        agent_id: agent.id,
        reason: decisionRecord.result.message,
        timestamp: eventTimestamp,
      });
    }

    if (decisionRecord.result.decision === "deny") {
      errorResponse(
        res,
        403,
        decisionRecord.result.reason,
        decisionRecord.result.message,
      );
      return;
    }

    if (decisionRecord.result.decision === "needs_approval") {
      res.status(202).json({
        status: "pending_approval",
        approval_id: decisionRecord.approvalId,
        reason: decisionRecord.result.reason,
      });
      return;
    }

    let paymentIntent: GatewayPaymentIntent | undefined;
    let confirmationAttempted = false;
    try {
      paymentIntent = await paymentProvider.retrievePaymentIntent(
        request.payment_intent_id,
      );
      if (
        paymentIntent.id !== request.payment_intent_id ||
        paymentIntent.amount !== request.amount ||
        paymentIntent.currency.toLowerCase() !== request.currency ||
        paymentIntent.metadata.seller_id !== request.seller_id ||
        paymentIntent.metadata.resource_id !== request.resource_id ||
        !["requires_payment_method", "requires_confirmation"].includes(
          paymentIntent.status,
        )
      ) {
        throw new Error("PaymentIntent does not match the authorized purchase");
      }

      confirmationAttempted = true;
      const confirmed = await paymentProvider.confirmPaymentIntent(
        request.payment_intent_id,
        paymentMethod,
      );
      if (
        confirmed.id !== request.payment_intent_id ||
        confirmed.amount !== request.amount ||
        confirmed.currency.toLowerCase() !== request.currency ||
        confirmed.metadata.seller_id !== request.seller_id ||
        confirmed.metadata.resource_id !== request.resource_id ||
        confirmed.status !== "succeeded"
      ) {
        throw new Error("PaymentIntent confirmation did not succeed");
      }
    } catch (error) {
      const timestamp = now().toISOString();
      const matchesIntent = (intent: GatewayPaymentIntent): boolean =>
        intent.id === request.payment_intent_id &&
        intent.amount === request.amount &&
        intent.currency.toLowerCase() === request.currency &&
        intent.metadata.seller_id === request.seller_id &&
        intent.metadata.resource_id === request.resource_id;
      const recovery = await recoverPaymentIntent(
        paymentProvider,
        request.payment_intent_id,
        matchesIntent,
      );
      const outcome =
        !confirmationAttempted && paymentIntent && !matchesIntent(paymentIntent)
          ? { status: "not_succeeded" as const, intent: paymentIntent }
          : !confirmationAttempted && paymentIntent?.status === "succeeded"
            ? { status: "succeeded" as const, intent: paymentIntent }
          : recovery;
      if (outcome.status === "succeeded") {
        database.transaction(() => {
          const updated = database
            .prepare(
              "UPDATE transactions SET status = 'succeeded', reason = 'OK', updated_at = ? WHERE id = ? AND status = 'processing'",
            )
            .run(timestamp, decisionRecord.transactionId);
          if (updated.changes !== 1) {
            throw new Error("Recovered payment could not be persisted");
          }
          writeAudit(database, {
            ts: timestamp,
            agentId: agent.id,
            event: "PAYMENT_SUCCEEDED",
            reason: "OK",
            amount: request.amount,
            refId: decisionRecord.transactionId,
            detail: {
              payment_intent_id: request.payment_intent_id,
              recovered_after_provider_error: true,
            },
          });
        })();
        events.publish("transaction", {
          ...transactionEvent,
          status: "succeeded",
          reason: "OK",
        });
        res.json({
          status: "paid",
          transaction_id: decisionRecord.transactionId,
          payment_intent_id: request.payment_intent_id,
          decision: "allow",
          reason: decisionRecord.result.reason,
        });
        return;
      }

      if (outcome.status === "unknown") {
        database.transaction(() => {
          database
            .prepare(
              "UPDATE transactions SET updated_at = ? WHERE id = ? AND status = 'processing'",
            )
            .run(timestamp, decisionRecord.transactionId);
          writeAudit(database, {
            ts: timestamp,
            agentId: agent.id,
            event: "PAYMENT_RECONCILIATION_PENDING",
            reason: "PAYMENT_PROVIDER_ERROR",
            amount: request.amount,
            refId: decisionRecord.transactionId,
            detail: {
              payment_intent_id: request.payment_intent_id,
              error_type: error instanceof Error ? error.name : "UnknownError",
              recovery_error_type:
                recovery.status === "unknown" ? recovery.errorType ?? null : null,
            },
          });
        })();
        events.publish("transaction", {
          ...transactionEvent,
          status: "processing",
          reason: "PAYMENT_RECONCILIATION_PENDING",
        });
        res.status(202).json({
          status: "processing",
          transaction_id: decisionRecord.transactionId,
          payment_intent_id: request.payment_intent_id,
          reason: "PAYMENT_RECONCILIATION_PENDING",
        });
        return;
      }

      database.transaction(() => {
        database
          .prepare(
            `UPDATE transactions
             SET status = 'failed', reason = 'PAYMENT_PROVIDER_ERROR', updated_at = ?
             WHERE id = ? AND status = 'processing'`,
          )
          .run(timestamp, decisionRecord.transactionId);
        writeAudit(database, {
          ts: timestamp,
          agentId: agent.id,
          event: "PAYMENT_FAILED",
          reason: "PAYMENT_PROVIDER_ERROR",
          amount: request.amount,
          refId: decisionRecord.transactionId,
          detail: {
            payment_intent_id: request.payment_intent_id,
            error_type: error instanceof Error ? error.name : "UnknownError",
          },
        });
      })();
      events.publish("transaction", {
        ...transactionEvent,
        status: "failed",
        reason: "PAYMENT_PROVIDER_ERROR",
      });
      console.error("Gateway payment provider operation failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      errorResponse(
        res,
        502,
        "PAYMENT_PROVIDER_ERROR",
        "The payment provider could not complete this payment",
      );
      return;
    }

    const timestamp = now().toISOString();
    database.transaction(() => {
      const updated = database
        .prepare(
          "UPDATE transactions SET status = 'succeeded', updated_at = ? WHERE id = ? AND status = 'processing'",
        )
        .run(timestamp, decisionRecord.transactionId);
      if (updated.changes !== 1) {
        throw new Error("Confirmed payment could not be persisted");
      }
      writeAudit(database, {
        ts: timestamp,
        agentId: agent.id,
        event: "PAYMENT_SUCCEEDED",
        reason: "OK",
        amount: request.amount,
        refId: decisionRecord.transactionId,
        detail: { payment_intent_id: request.payment_intent_id },
      });
    })();
    events.publish("transaction", { ...transactionEvent, status: "succeeded" });
    res.json({
      status: "paid",
      transaction_id: decisionRecord.transactionId,
      payment_intent_id: request.payment_intent_id,
      decision: "allow",
      reason: decisionRecord.result.reason,
    });
  }));

  app.get("/v1/pay/:paymentIntentId", asyncHandler(async (req, res) => {
    let transaction = database
      .prepare(
        `SELECT id, agent_id, payment_intent_id, amount, status, reason,
                seller_id, resource_id, currency, decision
         FROM transactions WHERE payment_intent_id = ?`,
      )
      .get(req.params.paymentIntentId) as (TransactionRow & {
        agent_id: string;
        seller_id: string;
        resource_id: string;
        currency: string;
        decision: string;
      }) | undefined;
    if (!transaction) {
      errorResponse(res, 404, "TRANSACTION_NOT_FOUND", "The transaction does not exist");
      return;
    }
    if (!authenticateRequest(req, database, transaction.agent_id)) {
      errorResponse(res, 401, "BAD_AGENT_KEY", "The agent key is invalid");
      return;
    }

    const needsReconciliation =
      transaction.status === "processing" &&
      Boolean(
        database
          .prepare(
            `SELECT 1 FROM audit_log
             WHERE ref_id = ? AND event = 'PAYMENT_RECONCILIATION_PENDING'`,
          )
          .get(transaction.id),
      );
    if (needsReconciliation) {
      const recovery = await recoverPaymentIntent(
        paymentProvider,
        transaction.payment_intent_id,
        (intent) =>
          intent.id === transaction?.payment_intent_id &&
          intent.amount === transaction.amount &&
          intent.currency.toLowerCase() === transaction.currency &&
          intent.metadata.seller_id === transaction.seller_id &&
          intent.metadata.resource_id === transaction.resource_id,
      );
      if (recovery.status !== "unknown") {
        const succeeded = recovery.status === "succeeded";
        const timestamp = now().toISOString();
        const status = succeeded ? "succeeded" : "failed";
        const reason = succeeded ? transaction.reason : "PAYMENT_PROVIDER_ERROR";
        const updated = database.transaction(() => {
          const result = database
            .prepare(
              `UPDATE transactions SET status = ?, reason = ?, updated_at = ?
               WHERE id = ? AND status = 'processing'`,
            )
            .run(status, reason, timestamp, transaction?.id);
          if (result.changes !== 1) {
            return false;
          }
          writeAudit(database, {
            ts: timestamp,
            agentId: transaction!.agent_id,
            event: succeeded ? "PAYMENT_SUCCEEDED" : "PAYMENT_FAILED",
            reason,
            amount: transaction!.amount,
            refId: transaction!.id,
            detail: {
              payment_intent_id: transaction!.payment_intent_id,
              recovered_after_provider_error: true,
            },
          });
          return true;
        })();
        if (updated) {
          events.publish("transaction", {
            id: transaction.id,
            agent_id: transaction.agent_id,
            payment_intent_id: transaction.payment_intent_id,
            seller_id: transaction.seller_id,
            resource_id: transaction.resource_id,
            amount: transaction.amount,
            status,
            decision: transaction.decision,
            reason,
            created_at: timestamp,
          });
          transaction = { ...transaction, status, reason };
        }
      }
    }

    const status =
      transaction.status === "succeeded"
        ? "paid"
        : transaction.status;
    res.json({
      status,
      reason: transaction.reason,
      transaction_id: transaction.id,
      payment_intent_id: transaction.payment_intent_id,
    });
  }));

  app.get("/v1/agents/:agentId/budget", (req, res) => {
    const agentId = req.params.agentId;
    const agent = database
      .prepare("SELECT id, api_key_hash, frozen, frozen_reason FROM agents WHERE id = ?")
      .get(agentId) as AgentRow | undefined;
    if (!agent) {
      errorResponse(res, 404, "AGENT_NOT_FOUND", "The agent does not exist");
      return;
    }

    const authenticatedAgent = authenticateRequest(req, database, agentId);
    if (!authenticatedAgent && !authenticateAdmin(req, adminKey)) {
      errorResponse(res, 401, "BAD_AGENT_KEY", "The agent or admin key is invalid");
      return;
    }

    const policy = database
      .prepare("SELECT daily_cap FROM policies WHERE agent_id = ?")
      .get(agentId) as { daily_cap: number } | undefined;
    if (!policy) {
      errorResponse(res, 404, "POLICY_NOT_FOUND", "The agent policy does not exist");
      return;
    }
    const utcDay = now().toISOString().slice(0, 10);
    const totals = database
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'succeeded' THEN amount ELSE 0 END), 0) AS spent_today,
           COALESCE(SUM(CASE WHEN status IN ('pending_approval', 'processing') THEN amount ELSE 0 END), 0) AS pending_today
         FROM transactions
         WHERE agent_id = ? AND substr(created_at, 1, 10) = ?`,
      )
      .get(agentId, utcDay) as { spent_today: number; pending_today: number };
    res.json({
      agent_id: agentId,
      daily_cap: policy.daily_cap,
      spent_today: totals.spent_today,
      pending_today: totals.pending_today,
      remaining: Math.max(
        0,
        policy.daily_cap - totals.spent_today - totals.pending_today,
      ),
      frozen: agent.frozen === 1,
      frozen_reason: agent.frozen_reason,
    });
  });

  app.use((_req, res) => {
    errorResponse(res, 404, "NOT_FOUND", "The requested endpoint does not exist");
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
      console.error("Gateway request failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
    errorResponse(
      res,
      status,
      status === 400 ? "INVALID_REQUEST" : "INTERNAL_ERROR",
      status === 400 ? "The request could not be parsed" : "The gateway could not process the request",
    );
  };
  app.use(handleError);

  return app;
}
