import { z } from "zod";

export type Decision = "allow" | "deny" | "needs_approval";

export type ReasonCode =
  | "OK"
  | "APPROVAL_REQUIRED"
  | "PER_PURCHASE_CAP_EXCEEDED"
  | "DAILY_CAP_EXCEEDED"
  | "SELLER_NOT_ALLOWED"
  | "AGENT_FROZEN"
  | "VELOCITY_LIMIT_EXCEEDED"
  | "CURRENCY_NOT_ALLOWED"
  | "DUPLICATE_PAYMENT_INTENT"
  | "APPROVAL_REJECTED"
  | "PAYMENT_PROVIDER_ERROR";

export const payRequestSchema = z.object({
  agent_id: z.string().min(1),
  payment_intent_id: z.string().min(1),
  seller_id: z.string().min(1),
  resource_id: z.string().min(1),
  amount: z.number().int().positive(),
  currency: z.string().min(1),
  purpose: z.string().min(1),
});

export type PayRequest = z.infer<typeof payRequestSchema>;

export interface PolicyConfig {
  per_purchase_cap: number;
  daily_cap: number;
  approval_threshold: number;
  velocity_max: number;
  velocity_window_s: number;
  allowed_sellers: string[];
  allowed_currencies: string[];
  auto_freeze_on_velocity: boolean;
}
