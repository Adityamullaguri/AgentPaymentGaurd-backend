import { describe, expect, it, vi } from "vitest";
import {
  createBenchmarkPlan,
  getPendingBenchmarkPlan,
  isPolicyDenialReason,
  main,
  renderResultsMarkdown,
  summarizeBenchmarkRuns,
  type BenchmarkRun,
} from "./bench.js";

describe("T8 benchmark", () => {
  it("plans the 60 scenario runs in passthrough then guarded mode", () => {
    const plan = createBenchmarkPlan();

    expect(plan).toHaveLength(60);
    expect(plan.slice(0, 10)).toEqual(
      Array.from({ length: 10 }, (_, index) => ({
        scenario: "A",
        mode: "passthrough",
        run: index + 1,
      })),
    );
    expect(plan.slice(30, 40)).toEqual(
      Array.from({ length: 10 }, (_, index) => ({
        scenario: "A",
        mode: "guarded",
        run: index + 1,
      })),
    );
  });

  it("counts only policy denials as false blocks", () => {
    expect(isPolicyDenialReason("DAILY_CAP_EXCEEDED")).toBe(true);
    expect(isPolicyDenialReason("SELLER_UNAVAILABLE")).toBe(false);
    expect(isPolicyDenialReason("GATEWAY_HTTP_502")).toBe(false);
  });

  it("resumes past completed and interrupted runs without replaying them", () => {
    const recordedRun = (run: number): BenchmarkRun => ({
      scenario: "A",
      mode: "passthrough",
      run,
      centsSpent: run === 4 ? 4_100 : 5_000,
      purchases: run === 4 ? 41 : 50,
      timeToStopMs: null,
      falseBlocks: null,
      stopReason: run === 4 ? "INTERRUPTED" : "RECOVERED_COMPLETED_RUN",
    });

    const pending = getPendingBenchmarkPlan(
      [recordedRun(1), recordedRun(2), recordedRun(3)],
      [recordedRun(4)],
    );

    expect(pending).toHaveLength(56);
    expect(pending[0]).toEqual({
      scenario: "A",
      mode: "passthrough",
      run: 5,
    });
    expect(
      pending.some(
        (item) =>
          item.scenario === "A" &&
          item.mode === "passthrough" &&
          item.run <= 4,
      ),
    ).toBe(false);
  });

  it("aggregates mean, max, time-to-stop, and total legitimate false blocks", () => {
    const runs: BenchmarkRun[] = [
      {
        scenario: "A",
        mode: "passthrough",
        run: 1,
        centsSpent: 5_000,
        purchases: 50,
        timeToStopMs: 120,
        falseBlocks: null,
        stopReason: "SCENARIO_COMPLETED",
      },
      {
        scenario: "A",
        mode: "passthrough",
        run: 2,
        centsSpent: 4_900,
        purchases: 49,
        timeToStopMs: 100,
        falseBlocks: null,
        stopReason: "SELLER_UNAVAILABLE",
      },
      {
        scenario: "A",
        mode: "guarded",
        run: 1,
        centsSpent: 500,
        purchases: 5,
        timeToStopMs: 80,
        falseBlocks: null,
        stopReason: "DAILY_CAP_EXCEEDED",
      },
      {
        scenario: "B",
        mode: "guarded",
        run: 1,
        centsSpent: 300,
        purchases: 3,
        timeToStopMs: null,
        falseBlocks: 1,
        stopReason: "DAILY_CAP_EXCEEDED",
      },
      {
        scenario: "B",
        mode: "guarded",
        run: 2,
        centsSpent: 400,
        purchases: 4,
        timeToStopMs: null,
        falseBlocks: 0,
        stopReason: "SCENARIO_COMPLETED",
      },
    ];

    const metrics = summarizeBenchmarkRuns(runs);

    expect(
      metrics.find(
        (metric) => metric.scenario === "A" && metric.mode === "passthrough",
      ),
    ).toMatchObject({
      runCount: 2,
      meanCentsSpent: 4_950,
      maxCentsSpent: 5_000,
      meanPurchases: 49.5,
      meanTimeToStopMs: null,
    });
    expect(
      metrics.find(
        (metric) => metric.scenario === "B" && metric.mode === "guarded",
      ),
    ).toMatchObject({ falseBlocks: 1, meanPurchases: 3.5 });
    expect(
      metrics.find(
        (metric) =>
          metric.scenario === "C" &&
          metric.mode === "guarded (auto-approve)",
      ),
    ).toMatchObject({ mode: "guarded (auto-approve)", meanTimeToStopMs: null });
  });

  it("renders the results table and evidence-based headline", () => {
    const runs: BenchmarkRun[] = [
      {
        scenario: "A",
        mode: "passthrough",
        run: 1,
        centsSpent: 5_000,
        purchases: 50,
        timeToStopMs: null,
        falseBlocks: null,
        stopReason: "SCENARIO_COMPLETED",
      },
      {
        scenario: "A",
        mode: "guarded",
        run: 1,
        centsSpent: 500,
        purchases: 5,
        timeToStopMs: 75,
        falseBlocks: null,
        stopReason: "DAILY_CAP_EXCEEDED",
      },
      {
        scenario: "B",
        mode: "guarded",
        run: 1,
        centsSpent: 400,
        purchases: 4,
        timeToStopMs: null,
        falseBlocks: 0,
        stopReason: "SCENARIO_COMPLETED",
      },
    ];

    const interruptedRun: BenchmarkRun = {
      scenario: "A",
      mode: "passthrough",
      run: 4,
      centsSpent: 4_100,
      purchases: 41,
      timeToStopMs: null,
      falseBlocks: null,
      stopReason: "GATEWAY_UNAVAILABLE",
    };
    const markdown = renderResultsMarkdown(
      summarizeBenchmarkRuns(runs),
      "2026-01-01T00:00:00.000Z",
      [interruptedRun],
    );

    expect(markdown).toContain(
      "| Runaway | passthrough | 1 | 5000 | 5000 | 50 | n/a | n/a |",
    );
    expect(markdown).toContain("Interrupted attempts: A/passthrough run 4 (4100 cents, 41 purchases, GATEWAY_UNAVAILABLE).");
    expect(markdown).toContain("| Big | guarded (auto-approve) |");
    expect(markdown).toContain(
      "Unguarded, a runaway agent spent 5000 cents; with AgentPay Guard it was stopped at 500 cents after 75 ms",
    );
  });

  it("provides a no-network dry run", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await main(["--dry-run"]);
      expect(log).toHaveBeenCalledWith(
        "Dry run only: 60 benchmark runs; no network requests or files changed.",
      );
    } finally {
      log.mockRestore();
    }
  });
});
