import { timingSafeEqual } from "node:crypto";
import {
  runBuyerScenario,
  type BuyerConfig,
  type BuyerDependencies,
} from "@agentpay/buyer";
import express, {
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type Database from "better-sqlite3";
import { z } from "zod";
import { hashApiKey } from "./database.js";
import { GatewayEventHub } from "./events.js";
import {
  type GatewayPaymentProvider,
  type GatewayPaymentIntent,
} from "./pay.js";
import { recoverPaymentIntent } from "./payment-reconciliation.js";

interface AdminDependencies {
  database: Database.Database;
  adminKey: string;
  paymentProvider: GatewayPaymentProvider;
  paymentMethod: string;
  events: GatewayEventHub;
  now: () => Date;
  nodeEnv: string;
  projectRoot: string;
  demoRunner?: DemoRunner;
}

export type DemoScenario = "happy" | "approval" | "runaway";
type DemoRouteScenario =
  | "happy_path"
  | "large_purchase"
  | "runaway"
  | "runaway_unguarded"
  | "happy"
  | "approval"
  | "baseline";

function resolveDemoScenario(
  scenario: string,
): { canonical: string; buyer: DemoScenario; baseline: boolean } | undefined {
  switch (scenario as DemoRouteScenario) {
    case "happy_path":
    case "happy":
      return { canonical: "happy_path", buyer: "happy", baseline: false };
    case "large_purchase":
    case "approval":
      return { canonical: "large_purchase", buyer: "approval", baseline: false };
    case "runaway":
      return { canonical: "runaway", buyer: "runaway", baseline: false };
    case "runaway_unguarded":
    case "baseline":
      return { canonical: "runaway_unguarded", buyer: "runaway", baseline: true };
    default:
      return undefined;
  }
}
export type DemoRunner = (
  scenario: DemoScenario,
  onOutput: (line: string) => void,
  signal: AbortSignal,
) => Promise<number | null>;

async function runBuyerInProcess(
  scenario: DemoScenario,
  signal: AbortSignal,
): Promise<number | null> {
  if (signal.aborted) return null;
  const config: BuyerConfig = {
    sellerUrl: process.env.SELLER_URL?.replace(/\/+$/, "") || "http://localhost:4001",
    gatewayUrl: process.env.GATEWAY_URL?.replace(/\/+$/, "") || "http://localhost:4002",
    agentId: process.env.BUYER_AGENT_ID?.trim() || "agent_buyer_1",
    agentKey: process.env.BUYER_AGENT_KEY?.trim() || "",
  };
  if (!config.agentKey) {
    throw new Error("BUYER_AGENT_KEY must be configured for demo scenarios");
  }
  const dependencies: BuyerDependencies = {
    fetch,
    sleep: (milliseconds) =>
      new Promise((resolveSleep) => {
        const timer = setTimeout(resolveSleep, milliseconds);
        const cancel = () => {
          clearTimeout(timer);
          resolveSleep();
        };
        signal.addEventListener("abort", cancel, { once: true });
      }),
    now: Date.now,
    log: (line) => console.log(`Demo buyer: ${line}`),
    signal,
  };
  const result = await runBuyerScenario(scenario, config, dependencies);
  return result.stopReason === "SCENARIO_COMPLETED" ? 0 : 1;
}

interface ApprovalRow {
  id: string;
  transaction_id: string;
  agent_id: string;
  amount: number;
  status: "pending" | "approved" | "rejected" | "expired";
  note: string | null;
  requested_at: string;
  resolved_at: string | null;
  payment_intent_id: string;
  seller_id: string;
  resource_id: string;
  currency: string;
  purpose: string | null;
  decision: string;
  reason: string;
}

interface AgentRow {
  id: string;
  name: string;
  frozen: number;
  frozen_reason: string | null;
  per_purchase_cap: number;
  daily_cap: number;
  approval_threshold: number;
  velocity_max: number;
  velocity_window_s: number;
  allowed_sellers: string;
  allowed_currencies: string;
  auto_freeze_on_velocity: number;
  spent_today: number;
  pending_today: number;
}

interface TransactionPaymentRecord {
  id: string;
  agent_id: string;
  payment_intent_id: string;
  seller_id: string;
  resource_id: string;
  amount: number;
  currency: string;
  purpose: string | null;
  created_at: string;
  decision: string;
  reason: string;
}

const policyUpdateSchema = z.object({
  per_purchase_cap: z.number().int().positive(),
  daily_cap: z.number().int().positive(),
  approval_threshold: z.number().int().nonnegative(),
  velocity_max: z.number().int().positive(),
  velocity_window_s: z.number().int().positive(),
  allowed_sellers: z.array(z.string().min(1)).min(1),
  allowed_currencies: z.array(z.string().regex(/^[a-zA-Z]{3}$/)).min(1),
  auto_freeze_on_velocity: z.boolean().optional(),
}).strict();

const approvalDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(1000).optional(),
}).strict();

const modeSchema = z.object({
  mode: z.enum(["guarded", "passthrough"]),
}).strict();

function respondError(
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

function isAuthorized(req: Request, adminKey: string): boolean {
  const provided = req.header("X-Admin-Key");
  if (!provided) {
    return false;
  }
  const providedHash = Buffer.from(hashApiKey(provided), "hex");
  const expectedHash = Buffer.from(hashApiKey(adminKey), "hex");
  return (
    providedHash.length === expectedHash.length &&
    timingSafeEqual(providedHash, expectedHash)
  );
}

function audit(
  database: Database.Database,
  values: {
    ts: string;
    agentId: string | null;
    event: string;
    reason: string | null;
    amount: number | null;
    refId: string | null;
    detail: unknown;
  },
): void {
  database
    .prepare(
      `INSERT INTO audit_log (ts, agent_id, event, reason, amount, ref_id, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      values.ts,
      values.agentId,
      values.event,
      values.reason,
      values.amount,
      values.refId,
      JSON.stringify(values.detail),
    );
}

function lookupApproval(
  database: Database.Database,
  approvalId: string,
): ApprovalRow | undefined {
  return database
    .prepare(
      `SELECT a.id, a.transaction_id, a.agent_id, a.amount, a.status, a.note,
              a.requested_at, a.resolved_at, t.payment_intent_id, t.seller_id,
              t.resource_id, t.currency, t.purpose, t.decision, t.reason
       FROM approvals a
       JOIN transactions t ON t.id = a.transaction_id
       WHERE a.id = ?`,
    )
    .get(approvalId) as ApprovalRow | undefined;
}

function publishTransaction(
  events: GatewayEventHub,
  transaction: {
    id: string;
    agent_id: string;
    payment_intent_id: string;
    seller_id: string;
    resource_id: string;
    amount: number;
    status: string;
    decision: string;
    reason: string;
    created_at: string;
  },
): void {
  events.publish("transaction", transaction);
}

function validateIntentMatches(
  intent: GatewayPaymentIntent,
  approval: ApprovalRow,
): boolean {
  return (
    intent.id === approval.payment_intent_id &&
    intent.amount === approval.amount &&
    intent.currency.toLowerCase() === approval.currency.toLowerCase() &&
    intent.metadata.seller_id === approval.seller_id &&
    intent.metadata.resource_id === approval.resource_id
  );
}

async function confirmApprovedPayment(
  database: Database.Database,
  approval: ApprovalRow,
  dependencies: AdminDependencies,
): Promise<
  | { status: "succeeded" }
  | { status: "failed"; message: string }
  | { status: "processing" }
> {
  const { paymentProvider, paymentMethod, now, events } = dependencies;
  let initialIntent: GatewayPaymentIntent | undefined;
  let confirmationAttempted = false;
  let providerError: unknown;
  let providerFailed = false;
  try {
    initialIntent = await paymentProvider.retrievePaymentIntent(
      approval.payment_intent_id,
    );
    if (
      !validateIntentMatches(initialIntent, approval) ||
      !["requires_payment_method", "requires_confirmation"].includes(initialIntent.status)
    ) {
      throw new Error("PaymentIntent does not match the approved purchase");
    }

    confirmationAttempted = true;
    const confirmed = await paymentProvider.confirmPaymentIntent(
      approval.payment_intent_id,
      paymentMethod,
    );
    if (!validateIntentMatches(confirmed, approval) || confirmed.status !== "succeeded") {
      throw new Error("PaymentIntent confirmation did not succeed");
    }
  } catch (error) {
    providerError = error;
    providerFailed = true;
  }

  if (providerFailed) {
    const recovery = await recoverPaymentIntent(
      paymentProvider,
      approval.payment_intent_id,
      (intent) => validateIntentMatches(intent, approval),
    );
    const outcome =
      !confirmationAttempted &&
      initialIntent &&
      !validateIntentMatches(initialIntent, approval)
        ? { status: "not_succeeded" as const, intent: initialIntent }
        : !confirmationAttempted && initialIntent?.status === "succeeded"
          ? { status: "succeeded" as const, intent: initialIntent }
        : recovery;
    const timestamp = now().toISOString();
    if (outcome.status === "unknown") {
      database.transaction(() => {
        database
          .prepare(
            `UPDATE transactions SET updated_at = ?
             WHERE id = ? AND status = 'processing'`,
          )
          .run(timestamp, approval.transaction_id);
        audit(database, {
          ts: timestamp,
          agentId: approval.agent_id,
          event: "PAYMENT_RECONCILIATION_PENDING",
          reason: "PAYMENT_PROVIDER_ERROR",
          amount: approval.amount,
          refId: approval.transaction_id,
          detail: {
            payment_intent_id: approval.payment_intent_id,
            error_type: providerError instanceof Error ? providerError.name : "UnknownError",
            recovery_error_type:
              recovery.status === "unknown" ? recovery.errorType ?? null : null,
          },
        });
      })();
      console.error("Approved gateway payment outcome is pending reconciliation", {
        errorType: providerError instanceof Error ? providerError.name : "UnknownError",
      });
      events.publish("approval_resolved", {
        approval_id: approval.id,
        transaction_id: approval.transaction_id,
        agent_id: approval.agent_id,
        status: "approved",
        reason: "PAYMENT_RECONCILIATION_PENDING",
        resolved_at: timestamp,
      });
      publishTransaction(events, {
        id: approval.transaction_id,
        agent_id: approval.agent_id,
        payment_intent_id: approval.payment_intent_id,
        seller_id: approval.seller_id,
        resource_id: approval.resource_id,
        amount: approval.amount,
        status: "processing",
        decision: "allow",
        reason: "PAYMENT_RECONCILIATION_PENDING",
        created_at: approval.requested_at,
      });
      return { status: "processing" };
    }

    if (outcome.status === "not_succeeded") {
      database.transaction(() => {
        database
          .prepare(
            `UPDATE transactions SET status = 'failed',
               reason = 'PAYMENT_PROVIDER_ERROR', updated_at = ?
             WHERE id = ? AND status = 'processing'`,
          )
          .run(timestamp, approval.transaction_id);
        audit(database, {
          ts: timestamp,
          agentId: approval.agent_id,
          event: "PAYMENT_FAILED",
          reason: "PAYMENT_PROVIDER_ERROR",
          amount: approval.amount,
          refId: approval.transaction_id,
          detail: {
            payment_intent_id: approval.payment_intent_id,
            error_type: providerError instanceof Error ? providerError.name : "UnknownError",
          },
        });
      })();
      console.error("Approved gateway payment failed", {
        errorType: providerError instanceof Error ? providerError.name : "UnknownError",
      });
      events.publish("approval_resolved", {
        approval_id: approval.id,
        transaction_id: approval.transaction_id,
        agent_id: approval.agent_id,
        status: "approved",
        reason: "PAYMENT_PROVIDER_ERROR",
        resolved_at: timestamp,
      });
      publishTransaction(events, {
        id: approval.transaction_id,
        agent_id: approval.agent_id,
        payment_intent_id: approval.payment_intent_id,
        seller_id: approval.seller_id,
        resource_id: approval.resource_id,
        amount: approval.amount,
        status: "failed",
        decision: "allow",
        reason: "PAYMENT_PROVIDER_ERROR",
        created_at: approval.requested_at,
      });
      return { status: "failed", message: "The approved payment could not be completed" };
    }
  }

  const timestamp = now().toISOString();
  const complete = database.transaction(() => {
    const update = database
      .prepare(
        `UPDATE transactions SET status = 'succeeded', updated_at = ?
         WHERE id = ? AND status = 'processing'`,
      )
      .run(timestamp, approval.transaction_id);
    if (update.changes !== 1) {
      throw new Error("Approved transaction was not in processing state");
    }
    audit(database, {
      ts: timestamp,
      agentId: approval.agent_id,
      event: "PAYMENT_SUCCEEDED",
      reason: "OK",
      amount: approval.amount,
      refId: approval.transaction_id,
      detail: {
        payment_intent_id: approval.payment_intent_id,
        recovered_after_provider_error: providerFailed,
      },
    });
  });
  complete();

  publishTransaction(events, {
    id: approval.transaction_id,
    agent_id: approval.agent_id,
    payment_intent_id: approval.payment_intent_id,
    seller_id: approval.seller_id,
    resource_id: approval.resource_id,
    amount: approval.amount,
    status: "succeeded",
    decision: "allow",
    reason: "OK",
    created_at: approval.requested_at,
  });
  events.publish("approval_resolved", {
    approval_id: approval.id,
    transaction_id: approval.transaction_id,
    agent_id: approval.agent_id,
    status: "approved",
    reason: "OK",
    resolved_at: timestamp,
  });
  return { status: "succeeded" };
}

export function expirePendingApprovals(
  dependencies: Pick<AdminDependencies, "database" | "now" | "events">,
): number {
  const { database, now, events } = dependencies;
  const cutoff = new Date(now().getTime() - 120_000).toISOString();
  const expired = database
    .prepare(
      `SELECT a.id AS approval_id, a.transaction_id, a.agent_id, a.amount,
              a.requested_at, t.payment_intent_id, t.seller_id, t.resource_id,
              t.decision, t.reason
       FROM approvals a
       JOIN transactions t ON t.id = a.transaction_id
       WHERE a.status = 'pending' AND a.requested_at <= ?`,
    )
    .all(cutoff) as Array<{
      approval_id: string;
      transaction_id: string;
      agent_id: string;
      amount: number;
      requested_at: string;
      payment_intent_id: string;
      seller_id: string;
      resource_id: string;
      decision: string;
      reason: string;
    }>;

  const resolved: typeof expired = [];
  const expire = database.transaction(() => {
    const timestamp = now().toISOString();
    for (const approval of expired) {
      const update = database
        .prepare(
          `UPDATE approvals SET status = 'expired', note = 'expired', resolved_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(timestamp, approval.approval_id);
      if (update.changes !== 1) {
        continue;
      }
      database
        .prepare(
          `UPDATE transactions SET status = 'rejected', decision = 'deny',
             reason = 'APPROVAL_REJECTED', updated_at = ?
           WHERE id = ? AND status = 'pending_approval'`,
        )
        .run(timestamp, approval.transaction_id);
      audit(database, {
        ts: timestamp,
        agentId: approval.agent_id,
        event: "EXPIRED",
        reason: "APPROVAL_REJECTED",
        amount: approval.amount,
        refId: approval.approval_id,
        detail: { note: "expired", transaction_id: approval.transaction_id },
      });
      resolved.push(approval);
    }
  });
  expire();
  const resolvedAt = now().toISOString();
  for (const approval of resolved) {
    events.publish("approval_resolved", {
      approval_id: approval.approval_id,
      transaction_id: approval.transaction_id,
      agent_id: approval.agent_id,
      status: "expired",
      reason: "APPROVAL_REJECTED",
      resolved_at: resolvedAt,
    });
    publishTransaction(events, {
      id: approval.transaction_id,
      agent_id: approval.agent_id,
      payment_intent_id: approval.payment_intent_id,
      seller_id: approval.seller_id,
      resource_id: approval.resource_id,
      amount: approval.amount,
      status: "rejected",
      decision: "deny",
      reason: "APPROVAL_REJECTED",
      created_at: approval.requested_at,
    });
  }
  return resolved.length;
}

export function createAdminRouter(dependencies: AdminDependencies): express.Router {
  const { database, adminKey, events, now, nodeEnv, projectRoot, demoRunner } =
    dependencies;
  const router = express.Router();
  let activeDemo:
    | { scenario: string; baseline: boolean; controller: AbortController }
    | undefined;
  const requireAdmin: RequestHandler = (req, res, next) => {
    if (!isAuthorized(req, adminKey)) {
      respondError(res, 401, "BAD_ADMIN_KEY", "The admin key is invalid");
      return;
    }
    next();
  };

  router.use(requireAdmin);

  router.get("/agents", (req, res) => {
    const utcDay = now().toISOString().slice(0, 10);
    const agents = database
      .prepare(
        `SELECT a.id, a.name, a.frozen, a.frozen_reason,
                p.per_purchase_cap, p.daily_cap, p.approval_threshold,
                p.velocity_max, p.velocity_window_s, p.allowed_sellers,
                p.allowed_currencies, p.auto_freeze_on_velocity,
                COALESCE(SUM(CASE WHEN t.status = 'succeeded' THEN t.amount ELSE 0 END), 0) AS spent_today,
                COALESCE(SUM(CASE WHEN t.status IN ('pending_approval','processing') THEN t.amount ELSE 0 END), 0) AS pending_today
         FROM agents a
         JOIN policies p ON p.agent_id = a.id
         LEFT JOIN transactions t ON t.agent_id = a.id AND substr(t.created_at, 1, 10) = ?
         GROUP BY a.id`,
      )
      .all(utcDay) as AgentRow[];
    const settings = database
      .prepare("SELECT value FROM settings WHERE key = 'policy_mode'")
      .get() as { value: string } | undefined;

    res.json({
      mode: settings?.value ?? "guarded",
      agents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        daily_cap: agent.daily_cap,
        spent_today: agent.spent_today,
        pending_today: agent.pending_today,
        remaining: Math.max(0, agent.daily_cap - agent.spent_today - agent.pending_today),
        frozen: agent.frozen === 1,
        frozen_reason: agent.frozen_reason,
        policy: {
          per_purchase_cap: agent.per_purchase_cap,
          daily_cap: agent.daily_cap,
          approval_threshold: agent.approval_threshold,
          velocity_max: agent.velocity_max,
          velocity_window_s: agent.velocity_window_s,
          allowed_sellers: JSON.parse(agent.allowed_sellers) as string[],
          allowed_currencies: JSON.parse(agent.allowed_currencies) as string[],
          auto_freeze_on_velocity: agent.auto_freeze_on_velocity === 1,
        },
      })),
    });
  });

  router.put("/agents/:id/policy", (req, res) => {
    const parsed = policyUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      respondError(res, 422, "INVALID_REQUEST", "The policy configuration is invalid");
      return;
    }
    const exists = database
      .prepare("SELECT id FROM agents WHERE id = ?")
      .get(req.params.id) as { id: string } | undefined;
    if (!exists) {
      respondError(res, 404, "AGENT_NOT_FOUND", "The agent does not exist");
      return;
    }

    const policy = parsed.data;
    const timestamp = now().toISOString();
    database.transaction(() => {
      database
        .prepare(
          `UPDATE policies SET per_purchase_cap = ?, daily_cap = ?,
             approval_threshold = ?, velocity_max = ?, velocity_window_s = ?,
             allowed_sellers = ?, allowed_currencies = ?,
             auto_freeze_on_velocity = ?, updated_at = ?
           WHERE agent_id = ?`,
        )
        .run(
          policy.per_purchase_cap,
          policy.daily_cap,
          policy.approval_threshold,
          policy.velocity_max,
          policy.velocity_window_s,
          JSON.stringify(policy.allowed_sellers),
          JSON.stringify(policy.allowed_currencies.map((currency) => currency.toLowerCase())),
          Number(policy.auto_freeze_on_velocity ?? true),
          timestamp,
          req.params.id,
        );
      audit(database, {
        ts: timestamp,
        agentId: req.params.id,
        event: "POLICY_UPDATED",
        reason: null,
        amount: null,
        refId: req.params.id,
        detail: policy,
      });
    })();
    res.json({ agent_id: req.params.id, policy });
  });

  for (const [action, frozen] of [["freeze", true], ["unfreeze", false]] as const) {
    router.post(`/agents/:id/${action}`, (req, res) => {
      const agent = database
        .prepare("SELECT id, frozen, frozen_reason FROM agents WHERE id = ?")
        .get(req.params.id) as { id: string; frozen: number; frozen_reason: string | null } | undefined;
      if (!agent) {
        respondError(res, 404, "AGENT_NOT_FOUND", "The agent does not exist");
        return;
      }
      const reason =
        typeof req.body?.reason === "string" && req.body.reason.trim()
          ? req.body.reason.trim().slice(0, 500)
          : action === "freeze"
            ? "Frozen by operator"
            : null;
      const timestamp = now().toISOString();
      database.transaction(() => {
        database
          .prepare("UPDATE agents SET frozen = ?, frozen_reason = ? WHERE id = ?")
          .run(Number(frozen), frozen ? reason : null, agent.id);
        audit(database, {
          ts: timestamp,
          agentId: agent.id,
          event: frozen ? "FROZEN" : "UNFROZEN",
          reason: frozen ? reason : "OPERATOR_UNFROZEN",
          amount: null,
          refId: agent.id,
          detail: { reason },
        });
      })();
      if (frozen) {
        events.publish("agent_frozen", {
          agent_id: agent.id,
          reason: reason ?? "Frozen by operator",
          timestamp,
        });
      } else {
        events.publish("agent_unfrozen", { agent_id: agent.id, timestamp });
      }
      res.json({ agent_id: agent.id, frozen, frozen_reason: frozen ? reason : null });
    });
  }

  router.get("/approvals", (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : "pending";
    if (!["pending", "approved", "rejected", "expired"].includes(status)) {
      respondError(res, 400, "INVALID_STATUS", "The approval status is invalid");
      return;
    }
    const approvals = database
      .prepare(
        `SELECT a.id AS approval_id, a.transaction_id, a.agent_id, a.amount,
                a.status, a.note, a.requested_at, a.resolved_at,
                t.payment_intent_id, t.seller_id, t.resource_id, t.currency,
                t.purpose, t.reason
         FROM approvals a JOIN transactions t ON t.id = a.transaction_id
         WHERE a.status = ? ORDER BY a.requested_at DESC`,
      )
      .all(status);
    res.json({ approvals });
  });

  const handleApprovalDecision = asyncHandler(async (req, res) => {
    const approvalId = req.params.id;
    if (typeof approvalId !== "string") {
      respondError(res, 400, "INVALID_APPROVAL_ID", "The approval ID is invalid");
      return;
    }
    const routeDecision =
      req.path.endsWith("/approve")
        ? "approve"
        : req.path.endsWith("/reject")
          ? "reject"
          : undefined;
    const body =
      typeof req.body === "object" && req.body !== null && !Array.isArray(req.body)
        ? req.body as Record<string, unknown>
        : {};
    if (routeDecision && body.decision !== undefined && body.decision !== routeDecision) {
      respondError(res, 422, "INVALID_REQUEST", "The approval decision conflicts with the route");
      return;
    }
    const parsed = approvalDecisionSchema.safeParse(
      routeDecision ? { ...body, decision: routeDecision } : req.body,
    );
    if (!parsed.success) {
      respondError(res, 422, "INVALID_REQUEST", "The approval decision is invalid");
      return;
    }
    const approval = lookupApproval(database, approvalId);
    if (!approval) {
      respondError(res, 404, "APPROVAL_NOT_FOUND", "The approval does not exist");
      return;
    }
    if (approval.status !== "pending") {
      respondError(res, 409, "APPROVAL_ALREADY_RESOLVED", "The approval is no longer pending");
      return;
    }

    const timestamp = now().toISOString();
    const approvalCutoff = new Date(now().getTime() - 120_000).toISOString();
    if (approval.requested_at <= approvalCutoff) {
      expirePendingApprovals({ database, now, events });
      respondError(res, 409, "APPROVAL_ALREADY_RESOLVED", "The approval has expired");
      return;
    }

    if (parsed.data.decision === "reject") {
      const rejected = database.transaction(() => {
        const update = database
          .prepare(
            `UPDATE approvals SET status = 'rejected', note = ?, resolved_at = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .run(parsed.data.note ?? null, timestamp, approval.id);
        if (update.changes !== 1) {
          return false;
        }
        database
          .prepare(
            `UPDATE transactions SET status = 'rejected', decision = 'deny',
               reason = 'APPROVAL_REJECTED', updated_at = ?
             WHERE id = ? AND status = 'pending_approval'`,
          )
          .run(timestamp, approval.transaction_id);
        audit(database, {
          ts: timestamp,
          agentId: approval.agent_id,
          event: "REJECTED",
          reason: "APPROVAL_REJECTED",
          amount: approval.amount,
          refId: approval.id,
          detail: { note: parsed.data.note ?? null, transaction_id: approval.transaction_id },
        });
        return true;
      })();
      if (!rejected) {
        respondError(res, 409, "APPROVAL_ALREADY_RESOLVED", "The approval is no longer pending");
        return;
      }
      events.publish("approval_resolved", {
        approval_id: approval.id,
        transaction_id: approval.transaction_id,
        agent_id: approval.agent_id,
        status: "rejected",
        reason: "APPROVAL_REJECTED",
        resolved_at: timestamp,
      });
      publishTransaction(events, {
        id: approval.transaction_id,
        agent_id: approval.agent_id,
        payment_intent_id: approval.payment_intent_id,
        seller_id: approval.seller_id,
        resource_id: approval.resource_id,
        amount: approval.amount,
        status: "rejected",
        decision: "deny",
        reason: "APPROVAL_REJECTED",
        created_at: approval.requested_at,
      });
      res.json({ status: "rejected", approval_id: approval.id, reason: "APPROVAL_REJECTED" });
      return;
    }

    const currentAgent = database
      .prepare("SELECT id, frozen, frozen_reason FROM agents WHERE id = ?")
      .get(approval.agent_id) as { id: string; frozen: number; frozen_reason: string | null } | undefined;
    const policy = database
      .prepare("SELECT * FROM policies WHERE agent_id = ?")
      .get(approval.agent_id) as {
        per_purchase_cap: number;
        daily_cap: number;
        allowed_sellers: string;
      } | undefined;
    if (!currentAgent || !policy) {
      respondError(res, 500, "POLICY_UNAVAILABLE", "The agent policy could not be loaded");
      return;
    }

    const utcDay = now().toISOString().slice(0, 10);
    const totals = database
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'succeeded' THEN amount ELSE 0 END), 0) AS spent,
           COALESCE(SUM(CASE WHEN status IN ('pending_approval','processing') AND id != ? THEN amount ELSE 0 END), 0) AS reserved
         FROM transactions
         WHERE agent_id = ? AND substr(created_at, 1, 10) = ?`,
      )
      .get(approval.transaction_id, approval.agent_id, utcDay) as { spent: number; reserved: number };
    const allowedSellers = JSON.parse(policy.allowed_sellers) as string[];
    let denial: { reason: string; message: string } | undefined;
    if (currentAgent.frozen === 1) {
      denial = { reason: "AGENT_FROZEN", message: `Agent ${currentAgent.id} is frozen` };
    } else if (!allowedSellers.includes(approval.seller_id)) {
      denial = { reason: "SELLER_NOT_ALLOWED", message: `Seller ${approval.seller_id} is not on the allowlist` };
    } else if (approval.amount > policy.per_purchase_cap) {
      denial = {
        reason: "PER_PURCHASE_CAP_EXCEEDED",
        message: `Per-purchase cap of ${policy.per_purchase_cap} would be exceeded (requested ${approval.amount})`,
      };
    } else if (totals.spent + totals.reserved + approval.amount > policy.daily_cap) {
      denial = {
        reason: "DAILY_CAP_EXCEEDED",
        message: `Daily cap of ${policy.daily_cap} would be exceeded (spent ${totals.spent}, pending ${totals.reserved}, requested ${approval.amount})`,
      };
    }

    if (denial) {
      const denied = database.transaction(() => {
        const update = database
          .prepare(
            `UPDATE approvals SET status = 'rejected', note = ?, resolved_at = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .run(parsed.data.note ?? denial.message, timestamp, approval.id);
        if (update.changes !== 1) {
          return false;
        }
        database
          .prepare(
            `UPDATE transactions SET status = 'denied', decision = 'deny',
               reason = ?, updated_at = ? WHERE id = ? AND status = 'pending_approval'`,
          )
          .run(denial.reason, timestamp, approval.transaction_id);
        audit(database, {
          ts: timestamp,
          agentId: approval.agent_id,
          event: "DENIED",
          reason: denial.reason,
          amount: approval.amount,
          refId: approval.transaction_id,
          detail: { message: denial.message, approval_id: approval.id },
        });
        return true;
      })();
      if (!denied) {
        respondError(res, 409, "APPROVAL_ALREADY_RESOLVED", "The approval is no longer pending");
        return;
      }
      events.publish("approval_resolved", {
        approval_id: approval.id,
        transaction_id: approval.transaction_id,
        agent_id: approval.agent_id,
        status: "rejected",
        reason: denial.reason,
        resolved_at: timestamp,
      });
      publishTransaction(events, {
        id: approval.transaction_id,
        agent_id: approval.agent_id,
        payment_intent_id: approval.payment_intent_id,
        seller_id: approval.seller_id,
        resource_id: approval.resource_id,
        amount: approval.amount,
        status: "denied",
        decision: "deny",
        reason: denial.reason,
        created_at: approval.requested_at,
      });
      res.status(403).json({ error: { code: denial.reason, message: denial.message } });
      return;
    }

    const approvalResult = database.transaction(() => {
      const cutoff = new Date(now().getTime() - 120_000).toISOString();
      const update = database
        .prepare(
          `UPDATE approvals SET status = 'approved', note = ?, resolved_at = ?
           WHERE id = ? AND status = 'pending' AND requested_at > ?`,
        )
        .run(parsed.data.note ?? null, timestamp, approval.id, cutoff);
      if (update.changes !== 1) {
        const stillPending = database
          .prepare("SELECT requested_at FROM approvals WHERE id = ? AND status = 'pending'")
          .get(approval.id) as { requested_at: string } | undefined;
        return stillPending && stillPending.requested_at <= cutoff
          ? "expired" as const
          : "resolved" as const;
      }
      const transactionUpdate = database
        .prepare(
          `UPDATE transactions SET status = 'processing', updated_at = ?
           WHERE id = ? AND status = 'pending_approval'`,
        )
        .run(timestamp, approval.transaction_id);
      if (transactionUpdate.changes !== 1) {
        throw new Error("Approval transaction was not pending");
      }
      audit(database, {
        ts: timestamp,
        agentId: approval.agent_id,
        event: "APPROVED",
        reason: "OK",
        amount: approval.amount,
        refId: approval.id,
        detail: {
          transaction_id: approval.transaction_id,
          note: parsed.data.note ?? null,
        },
      });
      return "approved" as const;
    })();
    if (approvalResult !== "approved") {
      if (approvalResult === "expired") {
        expirePendingApprovals({ database, now, events });
      }
      respondError(res, 409, "APPROVAL_ALREADY_RESOLVED", "The approval is no longer pending");
      return;
    }

    const confirmed = await confirmApprovedPayment(database, {
      ...approval,
      status: "approved",
      note: parsed.data.note ?? null,
    }, dependencies);
    if (confirmed.status === "failed") {
      respondError(res, 502, "PAYMENT_PROVIDER_ERROR", confirmed.message);
      return;
    }
    if (confirmed.status === "processing") {
      res.status(202).json({
        status: "processing",
        approval_id: approval.id,
        transaction_id: approval.transaction_id,
        reason: "PAYMENT_RECONCILIATION_PENDING",
      });
      return;
    }
    res.json({ status: "approved", approval_id: approval.id, transaction_id: approval.transaction_id });
  });
  router.post("/approvals/:id/decision", handleApprovalDecision);
  router.post("/approvals/:id/approve", handleApprovalDecision);
  router.post("/approvals/:id/reject", handleApprovalDecision);

  router.get("/transactions", (req, res) => {
    const limit = parseLimit(req.query.limit);
    if (!limit) {
      respondError(res, 400, "INVALID_LIMIT", "Limit must be an integer from 1 to 500");
      return;
    }
    const filters: string[] = [];
    const parameters: Array<string | number> = [];
    if (typeof req.query.agent_id === "string" && req.query.agent_id) {
      filters.push("agent_id = ?");
      parameters.push(req.query.agent_id);
    }
    if (typeof req.query.decision === "string" && req.query.decision) {
      if (!["allow", "deny", "needs_approval"].includes(req.query.decision)) {
        respondError(res, 400, "INVALID_DECISION", "The transaction decision is invalid");
        return;
      }
      filters.push("decision = ?");
      parameters.push(req.query.decision);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = database
      .prepare(`SELECT * FROM transactions ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...parameters, limit);
    res.json({ transactions: rows });
  });

  router.get("/audit", (req, res) => {
    const limit = parseLimit(req.query.limit, 100);
    if (!limit) {
      respondError(res, 400, "INVALID_LIMIT", "Limit must be an integer from 1 to 500");
      return;
    }
    const filters: string[] = [];
    const parameters: Array<string | number> = [];
    if (typeof req.query.agent_id === "string" && req.query.agent_id) {
      filters.push("a.agent_id = ?");
      parameters.push(req.query.agent_id);
    }
    if (typeof req.query.event === "string" && req.query.event) {
      filters.push("a.event = ?");
      parameters.push(req.query.event);
    }
    if (typeof req.query.search === "string" && req.query.search) {
      filters.push(
        `(a.ref_id LIKE ? OR a.detail LIKE ? OR EXISTS (
          SELECT 1 FROM transactions t
          LEFT JOIN approvals ap ON ap.transaction_id = t.id
          WHERE t.payment_intent_id LIKE ?
            AND (t.id = a.ref_id OR t.payment_intent_id = a.ref_id OR ap.id = a.ref_id)
        ))`,
      );
      parameters.push(
        `%${req.query.search}%`,
        `%${req.query.search}%`,
        `%${req.query.search}%`,
      );
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = database
      .prepare(
        `SELECT a.*,
                COALESCE(
                  (SELECT t.payment_intent_id FROM transactions t WHERE t.id = a.ref_id LIMIT 1),
                  (SELECT t.payment_intent_id
                   FROM approvals ap JOIN transactions t ON t.id = ap.transaction_id
                   WHERE ap.id = a.ref_id LIMIT 1)
                ) AS payment_intent_id
         FROM audit_log a ${where} ORDER BY a.id DESC LIMIT ?`,
      )
      .all(...parameters, limit);
    res.json({ audit: rows });
  });

  router.post("/reset", (_req, res) => {
    if (nodeEnv === "production") {
      respondError(res, 403, "RESET_DISABLED", "Demo reset is disabled in production");
      return;
    }
    if (activeDemo) {
      respondError(res, 409, "DEMO_IN_PROGRESS", "Cannot reset while a demo scenario is running");
      return;
    }
    const timestamp = now().toISOString();
    const agents = database
      .prepare("SELECT id FROM agents WHERE frozen = 1")
      .all() as Array<{ id: string }>;
    database.transaction(() => {
      const processingTransactions = database
        .prepare(
          `SELECT id, agent_id, amount, payment_intent_id
           FROM transactions WHERE status = 'processing'`,
        )
        .all() as Array<{
          id: string;
          agent_id: string;
          amount: number;
          payment_intent_id: string;
        }>;
      for (const transaction of processingTransactions) {
        database
          .prepare(
            `UPDATE transactions
             SET status = 'failed', reason = 'DEMO_RESET', updated_at = ?
             WHERE id = ? AND status = 'processing'`,
          )
          .run(timestamp, transaction.id);
        audit(database, {
          ts: timestamp,
          agentId: transaction.agent_id,
          event: "PAYMENT_FAILED",
          reason: "DEMO_RESET",
          amount: transaction.amount,
          refId: transaction.id,
          detail: {
            payment_intent_id: transaction.payment_intent_id,
            message: "Processing payment marked failed during demo reset",
          },
        });
      }
      database.prepare("DELETE FROM approvals").run();
      database.prepare("DELETE FROM transactions").run();
      database
        .prepare("UPDATE agents SET frozen = 0, frozen_reason = NULL")
        .run();
      audit(database, {
        ts: timestamp,
        agentId: null,
        event: "RESET",
        reason: "DEMO_RESET",
        amount: null,
        refId: null,
        detail: { transactions_cleared: true, approvals_cleared: true },
      });
      for (const agent of agents) {
        audit(database, {
          ts: timestamp,
          agentId: agent.id,
          event: "UNFROZEN",
          reason: "DEMO_RESET",
          amount: null,
          refId: agent.id,
          detail: { reason: "Demo reset" },
        });
      }
    })();
    for (const agent of agents) {
      events.publish("agent_unfrozen", { agent_id: agent.id, timestamp });
    }
    res.json({ status: "reset" });
  });

  router.post("/demo/stop", (req, res) => {
    if (!activeDemo) {
      respondError(res, 409, "DEMO_NOT_RUNNING", "No demo scenario is currently running");
      return;
    }
    if (!activeDemo.controller.signal.aborted) {
      activeDemo.controller.abort();
      events.publish("demo_status", {
        scenario: activeDemo.scenario,
        status: "stopping",
      });
    }
    res.status(202).json({
      status: "stopping",
      scenario: activeDemo.scenario,
    });
  });

  router.post("/demo/:scenario", (req, res) => {
    if (nodeEnv === "production") {
      respondError(res, 403, "DEMO_DISABLED", "Demo scenarios are disabled in production");
      return;
    }
    const requestedScenario = req.params.scenario;
    const resolvedScenario = resolveDemoScenario(requestedScenario);
    if (!resolvedScenario) {
      respondError(res, 400, "INVALID_SCENARIO", "The demo scenario is not supported");
      return;
    }
    const { canonical: scenario, buyer: buyerScenario, baseline } = resolvedScenario;
    if (activeDemo) {
      respondError(res, 409, "DEMO_IN_PROGRESS", "A demo scenario is already running");
      return;
    }

    const controller = new AbortController();
    const demo = { scenario, baseline, controller };
    activeDemo = demo;
    events.publish("demo_status", { scenario, status: "started" });
    const setMode = (mode: "guarded" | "passthrough") => {
      const previous = database
        .prepare("SELECT value FROM settings WHERE key = 'policy_mode'")
        .get() as { value: string } | undefined;
      const timestamp = now().toISOString();
      database.transaction(() => {
        database
          .prepare(
            `INSERT INTO settings (key, value) VALUES ('policy_mode', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(mode);
        audit(database, {
          ts: timestamp,
          agentId: null,
          event: "MODE_CHANGED",
          reason: mode === "passthrough" ? "PASSTHROUGH_ENABLED" : "GUARDED_ENABLED",
          amount: null,
          refId: "policy_mode",
          detail: { from: previous?.value ?? "guarded", to: mode, source: "demo" },
        });
      })();
      events.publish("mode_changed", { mode });
    };

    void (async () => {
      let exitCode: number | null = null;
      let failure: string | undefined;
      try {
        if (baseline) {
          setMode("passthrough");
        }
        const runner: DemoRunner =
          demoRunner ??
          (async (name, onOutput, signal) => {
            const exitCode = await runBuyerInProcess(name, signal);
            onOutput(`SUMMARY stop_reason=${exitCode === 0 ? "SCENARIO_COMPLETED" : "SCENARIO_FAILED"}`);
            return exitCode;
          });
        exitCode = await runner(buyerScenario, (line) => {
          events.publish("demo_status", {
            scenario,
            status: "output",
            message: line.slice(0, 1000),
          });
        }, controller.signal);
      } catch (error) {
        failure = error instanceof Error ? error.message : "Unknown demo process error";
        console.error("Demo scenario failed", {
          scenario,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      } finally {
        try {
          if (baseline) {
            setMode("guarded");
          }
        } catch (error) {
          failure = `${failure ? `${failure}; ` : ""}Could not restore guarded mode`;
          console.error("Failed to restore guarded mode after baseline demo", {
            errorType: error instanceof Error ? error.name : "UnknownError",
          });
        }
        if (activeDemo === demo) {
          activeDemo = undefined;
        }
        events.publish("demo_status", {
          scenario,
          status: controller.signal.aborted ? "cancelled" : "completed",
          ...(failure ? { message: failure } : {}),
          exit_code: exitCode,
        });
      }
    })();

    res.status(202).json({ status: "started", scenario });
  });

  router.get("/mode", (_req, res) => {
    const setting = database
      .prepare("SELECT value FROM settings WHERE key = 'policy_mode'")
      .get() as { value: string } | undefined;
    res.json({
      mode: setting?.value === "passthrough" ? "passthrough" : "guarded",
    });
  });

  router.put("/mode", (req, res) => {
    if (activeDemo) {
      respondError(res, 409, "DEMO_IN_PROGRESS", "Cannot change mode while a demo scenario is running");
      return;
    }
    const parsed = modeSchema.safeParse(req.body);
    if (!parsed.success) {
      respondError(res, 422, "INVALID_REQUEST", "The policy mode is invalid");
      return;
    }
    const previous = database
      .prepare("SELECT value FROM settings WHERE key = 'policy_mode'")
      .get() as { value: string } | undefined;
    const timestamp = now().toISOString();
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO settings (key, value) VALUES ('policy_mode', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(parsed.data.mode);
      audit(database, {
        ts: timestamp,
        agentId: null,
        event: "MODE_CHANGED",
        reason: parsed.data.mode === "passthrough" ? "PASSTHROUGH_ENABLED" : "GUARDED_ENABLED",
        amount: null,
        refId: "policy_mode",
        detail: { from: previous?.value ?? "guarded", to: parsed.data.mode },
      });
    })();
    events.publish("mode_changed", { mode: parsed.data.mode });
    res.json({ mode: parsed.data.mode });
  });

  return router;
}

export function registerAdminEvents(
  app: express.Express,
  adminKey: string,
  events: GatewayEventHub,
): void {
  app.get("/v1/events", (req, res) => {
    if (!isAuthorized(req, adminKey)) {
      respondError(res, 401, "BAD_ADMIN_KEY", "The admin key is invalid");
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write("retry: 2000\n\n");

    const unsubscribe = events.subscribe((name, payload) => {
      res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}

function parseLimit(value: unknown, defaultValue = 50): number | undefined {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return undefined;
  }
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= 500
    ? limit
    : undefined;
}
