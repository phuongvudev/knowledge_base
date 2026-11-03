import { TelemetryService } from "../telemetry_service.js";

describe("TelemetryService", () => {
  it("creates default tracker", () => {
    const tracker = TelemetryService.createDefaultTracker();
    expect(tracker).toBeDefined();
  });
});
