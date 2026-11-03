import type { GatewayPaymentIntent, GatewayPaymentProvider } from "./pay.js";

export type PaymentRecovery =
  | { status: "succeeded"; intent: GatewayPaymentIntent }
  | { status: "not_succeeded"; intent: GatewayPaymentIntent }
  | { status: "unknown"; errorType?: string };

export async function recoverPaymentIntent(
  provider: GatewayPaymentProvider,
  paymentIntentId: string,
  matches: (intent: GatewayPaymentIntent) => boolean,
): Promise<PaymentRecovery> {
  try {
    const intent = await provider.retrievePaymentIntent(paymentIntentId);
    if (!matches(intent)) {
      return { status: "unknown" };
    }
    if (intent.status === "succeeded") {
      return { status: "succeeded", intent };
    }
    if (
      ["requires_payment_method", "requires_confirmation", "canceled"].includes(
        intent.status,
      )
    ) {
      return { status: "not_succeeded", intent };
    }
    return { status: "unknown" };
  } catch (error) {
    return {
      status: "unknown",
      errorType: error instanceof Error ? error.name : "UnknownError",
    };
  }
}
