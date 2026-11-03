import type {
  Decision,
  PayRequest,
  PolicyConfig,
  ReasonCode,
} from "@agentpay/shared";

export interface PolicyInput {
  request: PayRequest;
  now: Date;
}

export interface PolicyState {
  agent: { id: string; frozen: boolean };
  spent_today: number;
  pending_today: number;
  recent_purchase_times: Date[];
  known_payment_intent: boolean;
}

export interface PolicyResult {
  decision: Decision;
  reason: ReasonCode;
  message: string;
  freeze_agent?: boolean;
}

function result(
  decision: Decision,
  reason: ReasonCode,
  message: string,
  freeze_agent?: boolean,
): PolicyResult {
  return {
    decision,
    reason,
    message,
    ...(freeze_agent === undefined ? {} : { freeze_agent }),
  };
}

export function evaluatePolicy(
  input: PolicyInput,
  state: PolicyState,
  config: PolicyConfig,
): PolicyResult {
  const { request, now } = input;

  if (state.known_payment_intent) {
    return result(
      "deny",
      "DUPLICATE_PAYMENT_INTENT",
      `Payment intent ${request.payment_intent_id} has already been used`,
    );
  }

  if (state.agent.frozen) {
    return result("deny", "AGENT_FROZEN", `Agent ${state.agent.id} is frozen`);
  }

  if (!config.allowed_currencies.includes(request.currency)) {
    return result(
      "deny",
      "CURRENCY_NOT_ALLOWED",
      `Currency ${request.currency} is not allowed`,
    );
  }

  if (!config.allowed_sellers.includes(request.seller_id)) {
    return result(
      "deny",
      "SELLER_NOT_ALLOWED",
      `Seller ${request.seller_id} is not on the allowlist`,
    );
  }

  const windowStart = now.getTime() - config.velocity_window_s * 1000;
  const recentPurchaseCount = state.recent_purchase_times.filter((time) => {
    const timestamp = time.getTime();
    return timestamp >= windowStart && timestamp <= now.getTime();
  }).length;

  if (recentPurchaseCount >= config.velocity_max) {
    return result(
      "deny",
      "VELOCITY_LIMIT_EXCEEDED",
      `Velocity limit of ${config.velocity_max} purchases per ${config.velocity_window_s} seconds reached (${recentPurchaseCount} recent purchases)`,
      config.auto_freeze_on_velocity,
    );
  }

  if (request.amount > config.per_purchase_cap) {
    return result(
      "deny",
      "PER_PURCHASE_CAP_EXCEEDED",
      `Per-purchase cap of ${config.per_purchase_cap} would be exceeded (requested ${request.amount})`,
    );
  }

  if (state.spent_today + state.pending_today + request.amount > config.daily_cap) {
    return result(
      "deny",
      "DAILY_CAP_EXCEEDED",
      `Daily cap of ${config.daily_cap} would be exceeded (spent ${state.spent_today}, pending ${state.pending_today}, requested ${request.amount})`,
    );
  }

  if (request.amount > config.approval_threshold) {
    return result(
      "needs_approval",
      "APPROVAL_REQUIRED",
      `Purchase of ${request.amount} exceeds the approval threshold of ${config.approval_threshold}`,
    );
  }

  return result("allow", "OK", `Purchase of ${request.amount} is allowed`);
}
