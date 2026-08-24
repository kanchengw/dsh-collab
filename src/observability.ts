import { EventLedger } from "./events.js";

export interface ObservabilitySnapshot {
  requests: number;
  errors: number;
  events: number;
  slowMessages: number;
  connectionFrames: number;
  slowConnections: number;
  correlations: Array<{ requestId: string; eventIds: string[] }>;
}

export class CollabObservability {
  private readonly metrics: ObservabilitySnapshot = {
    requests: 0,
    errors: 0,
    events: 0,
    slowMessages: 0,
    connectionFrames: 0,
    slowConnections: 0,
    correlations: [],
  };
  private readonly slowThresholdMs: number;
  private readonly unsubscribe?: () => void;

  constructor(options: { ledger?: EventLedger; slowThresholdMs?: number } = {}) {
    this.slowThresholdMs = options.slowThresholdMs ?? 250;
    if (!Number.isSafeInteger(this.slowThresholdMs) || this.slowThresholdMs < 0) throw new Error("slowThresholdMs must be a non-negative integer");
    if (options.ledger) this.unsubscribe = options.ledger.subscribe(() => { this.metrics.events += 1; });
  }

  recordRequest(input: { requestId: string; status: number; durationMs: number; eventIds?: string[] }): void {
    this.metrics.requests += 1;
    if (input.status >= 400) this.metrics.errors += 1;
    if (input.durationMs >= this.slowThresholdMs) this.metrics.slowMessages += 1;
    if (input.eventIds?.length) this.metrics.correlations.push({ requestId: input.requestId, eventIds: [...new Set(input.eventIds)] });
  }

  recordConnectionFrame(_connectionId: string, durationMs: number): void {
    this.metrics.connectionFrames += 1;
    if (durationMs >= this.slowThresholdMs) this.metrics.slowConnections += 1;
  }

  snapshot(): ObservabilitySnapshot {
    return structuredClone(this.metrics);
  }

  dispose(): void {
    this.unsubscribe?.();
  }
}
