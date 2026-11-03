import { EventEmitter } from "node:events";

export interface GatewayEvents {
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
  };
  approval_requested: {
    approval_id: string;
    transaction_id: string;
    agent_id: string;
    seller_id: string;
    resource_id: string;
    amount: number;
    purpose: string | null;
    requested_at: string;
  };
  approval_resolved: {
    approval_id: string;
    transaction_id: string;
    agent_id: string;
    status: string;
    reason: string;
    resolved_at: string;
  };
  agent_frozen: {
    agent_id: string;
    reason: string;
    timestamp: string;
  };
  agent_unfrozen: {
    agent_id: string;
    timestamp: string;
  };
  mode_changed: {
    mode: "guarded" | "passthrough";
  };
  demo_status: {
    scenario: string;
    status: "started" | "output" | "stopping" | "completed" | "cancelled";
    message?: string;
    exit_code?: number | null;
  };
}

export type GatewayEventName = keyof GatewayEvents;
export type GatewayEventListener = <Name extends GatewayEventName>(
  name: Name,
  payload: GatewayEvents[Name],
) => void;

export class GatewayEventHub {
  private readonly emitter = new EventEmitter();

  publish<Name extends GatewayEventName>(
    name: Name,
    payload: GatewayEvents[Name],
  ): void {
    this.emitter.emit("gateway-event", name, payload);
  }

  subscribe(listener: GatewayEventListener): () => void {
    this.emitter.on("gateway-event", listener);
    return () => this.emitter.off("gateway-event", listener);
  }
}
