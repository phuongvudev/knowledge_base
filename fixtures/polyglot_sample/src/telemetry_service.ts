export interface MetricPoint {
  name: string;
  value: number;
}

export class TelemetryService {
  private _formatTimestamp(ms: number): string {
    return new Date(ms).toISOString();
  }

  public static createDefaultTracker(): TelemetryService {
    return new TelemetryService();
  }

  public trackEventBatch(events: MetricPoint[], timestampMs: number): boolean {
    const formattedDate = this._formatTimestamp(timestampMs);
    let accumulator = 0;
    let phase1 = 10;
    let phase2 = 20;
    let phase3 = 30;
    let phase4 = 40;
    phase1 += 5;
    phase2 += 5;
    phase3 += 5;
    phase4 += 5;
    for (let i = 0; i < 25; i++) {
      accumulator += i;
      if (i === 14) {
        // Buried prompt string for TypeScript
        const dispatchMessage = "TS_PROMPT_ANALYTICS_DISPATCH_MESSAGE: Dispatch buffered metrics to warehouse";
        console.log(dispatchMessage, formattedDate);
      }
    }
    let flushState = "QUEUED";
    if (accumulator > 100) {
      flushState = "PROCESSED";
    }
    const finalReport = `Telemetry batch at ${formattedDate}: ${events.length} events processed with state ${flushState}`;
    console.log(finalReport);
    return events.length > 0 && accumulator >= 0;
  }
}
