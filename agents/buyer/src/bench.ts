import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "dotenv";
import { loadBuyerConfig, runBuyerScenario, type BuyerConfig } from "./index.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runsPerScenario = 10;
const mixedPurchaseCount = 4;
const mixedPurchaseDelayMs = 3_000;
const allowedEnvironmentNames = new Set([
  "ADMIN_KEY",
  "BUYER_AGENT_KEY",
  "BUYER_AGENT_ID",
  "GATEWAY_URL",
  "SELLER_URL",
  "STRIPE_SECRET_KEY",
  "NODE_ENV",
]);

type PolicyMode = "passthrough" | "guarded";
type ScenarioId = "A" | "B" | "C";

export interface BenchmarkRun {
  scenario: ScenarioId;
  mode: PolicyMode;
  run: number;
  centsSpent: number;
  purchases: number;
  timeToStopMs: number | null;
  falseBlocks: number | null;
  stopReason: string;
}

export interface BenchmarkMetrics {
  scenario: ScenarioId;
  mode: string;
  runCount: number;
  meanCentsSpent: number;
  maxCentsSpent: number;
  meanPurchases: number;
  meanTimeToStopMs: number | null;
  falseBlocks: number | null;
}

interface BenchmarkConfig {
  adminKey: string;
  buyer: BuyerConfig;
  gatewayUrl: string;
  sellerUrl: string;
}

interface AdminRequestOptions {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
}

interface AgentSummary {
  id: string;
  spent_today: number;
}

interface ApprovalSummary {
  approval_id: string;
  agent_id: string;
  amount: number;
  resource_id: string;
}

interface BenchmarkPlanItem {
  scenario: ScenarioId;
  mode: PolicyMode;
  run: number;
}

interface BenchmarkProgress {
  version: 1;
  generatedAt: string;
  stripeMode: "test";
  complete: boolean;
  runs: BenchmarkRun[];
  interruptedRuns: BenchmarkRun[];
  activeRun: BenchmarkPlanItem | null;
  completedAt?: string;
  metrics?: BenchmarkMetrics[];
}

const scenarioNames: Record<ScenarioId, string> = {
  A: "Runaway",
  B: "Mix",
  C: "Big",
};

export function isPolicyDenialReason(reason: string): boolean {
  return [
    "AGENT_FROZEN",
    "CURRENCY_NOT_ALLOWED",
    "SELLER_NOT_ALLOWED",
    "VELOCITY_LIMIT_EXCEEDED",
    "PER_PURCHASE_CAP_EXCEEDED",
    "DAILY_CAP_EXCEEDED",
  ].includes(reason);
}

export function createBenchmarkPlan(): Array<{
  scenario: ScenarioId;
  mode: PolicyMode;
  run: number;
}> {
  const plan: Array<{ scenario: ScenarioId; mode: PolicyMode; run: number }> = [];
  for (const mode of ["passthrough", "guarded"] as const) {
    for (const scenario of ["A", "B", "C"] as const) {
      for (let run = 1; run <= runsPerScenario; run += 1) {
        plan.push({ scenario, mode, run });
      }
    }
  }
  return plan;
}

export function getPendingBenchmarkPlan(
  runs: BenchmarkRun[],
  interruptedRuns: BenchmarkRun[],
): BenchmarkPlanItem[] {
  const recordedKeys = new Set(
    [...runs, ...interruptedRuns].map((run) => planKey(run)),
  );
  return createBenchmarkPlan().filter((item) => !recordedKeys.has(planKey(item)));
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 10) / 10;
}

export function summarizeBenchmarkRuns(runs: BenchmarkRun[]): BenchmarkMetrics[] {
  return (["A", "B", "C"] as const).flatMap((scenario) =>
    (["passthrough", "guarded"] as const).map((mode) => {
      const selected = runs.filter(
        (run) => run.scenario === scenario && run.mode === mode,
      );
      const times =
        scenario === "A" && mode === "passthrough"
          ? []
          : selected.flatMap((run) =>
              run.timeToStopMs === null ? [] : [run.timeToStopMs],
            );
      const hasFalseBlockMetric = scenario === "B";
      return {
        scenario,
        mode:
          scenario === "C" && mode === "guarded"
            ? "guarded (auto-approve)"
            : mode,
        runCount: selected.length,
        meanCentsSpent: mean(selected.map((run) => run.centsSpent)),
        maxCentsSpent: selected.reduce(
          (maximum, run) => Math.max(maximum, run.centsSpent),
          0,
        ),
        meanPurchases: mean(selected.map((run) => run.purchases)),
        meanTimeToStopMs: times.length === 0 ? null : mean(times),
        falseBlocks: hasFalseBlockMetric
          ? selected.reduce((total, run) => total + (run.falseBlocks ?? 0), 0)
          : null,
      };
    }),
  );
}

export function renderResultsMarkdown(
  metrics: BenchmarkMetrics[],
  generatedAt: string,
  interruptedRuns: BenchmarkRun[] = [],
): string {
  const rows = metrics
    .map(
      (metric) =>
        `| ${scenarioNames[metric.scenario]} | ${metric.mode} | ${metric.runCount} | ${metric.meanCentsSpent} | ${metric.maxCentsSpent} | ${metric.meanPurchases} | ${metric.meanTimeToStopMs === null ? "n/a" : metric.meanTimeToStopMs} | ${metric.falseBlocks === null ? "n/a" : metric.falseBlocks} |`,
    )
    .join("\n");
  const get = (scenario: ScenarioId, mode: PolicyMode): BenchmarkMetrics => {
    const metric = metrics.find(
      (candidate) =>
        candidate.scenario === scenario &&
        (candidate.mode === mode ||
          (scenario === "C" &&
            mode === "guarded" &&
            candidate.mode === "guarded (auto-approve)")),
    );
    if (!metric) {
      throw new Error(`Missing benchmark metrics for ${scenario}/${mode}`);
    }
    return metric;
  };
  const passthrough = get("A", "passthrough");
  const guarded = get("A", "guarded");
  const guardedMix = get("B", "guarded");

  return `# Benchmark results

Generated: ${generatedAt}

Stripe test mode. Scenario B uses four 100-cent purchases spaced 3 seconds apart. Scenario C automatically approves the guarded 400-cent purchase. The table reports completed runs; interrupted attempts are excluded.

| Scenario | Mode | Completed runs | Mean cents spent | Max cents spent | Mean purchases done | Mean time-to-stop (ms) | False blocks |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}

Unguarded, a runaway agent spent ${passthrough.meanCentsSpent} cents; with AgentPay Guard it was stopped at ${guarded.meanCentsSpent} cents after ${guarded.meanTimeToStopMs ?? "n/a"} ms, with ${guardedMix.falseBlocks ?? 0} false blocks across ${guardedMix.runCount * mixedPurchaseCount} legitimate purchases.

Interrupted attempts are excluded from the summary metrics. ${
    interruptedRuns.length === 0
      ? "No interrupted attempts."
      : `Interrupted attempts: ${interruptedRuns
          .map(
            (run) =>
              `${run.scenario}/${run.mode} run ${run.run} (${run.centsSpent} cents, ${run.purchases} purchases, ${run.stopReason})`,
          )
          .join("; ")}.`
  }
`;
}

function isScenarioId(value: unknown): value is ScenarioId {
  return value === "A" || value === "B" || value === "C";
}

function isPolicyMode(value: unknown): value is PolicyMode {
  return value === "passthrough" || value === "guarded";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBenchmarkPlanItem(value: unknown): value is BenchmarkPlanItem {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isScenarioId(value.scenario) &&
    isPolicyMode(value.mode) &&
    Number.isInteger(value.run) &&
    Number(value.run) >= 1 &&
    Number(value.run) <= runsPerScenario
  );
}

function isBenchmarkRun(value: unknown): value is BenchmarkRun {
  if (!isRecord(value) || !isBenchmarkPlanItem(value)) {
    return false;
  }
  return (
    Number.isFinite(value.centsSpent) &&
    Number(value.centsSpent) >= 0 &&
    Number.isInteger(value.purchases) &&
    Number(value.purchases) >= 0 &&
    (value.timeToStopMs === null ||
      (Number.isFinite(value.timeToStopMs) && Number(value.timeToStopMs) >= 0)) &&
    (value.falseBlocks === null ||
      (Number.isInteger(value.falseBlocks) && Number(value.falseBlocks) >= 0)) &&
    typeof value.stopReason === "string"
  );
}

function isBenchmarkMetrics(value: unknown): value is BenchmarkMetrics {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isScenarioId(value.scenario) &&
    typeof value.mode === "string" &&
    Number.isInteger(value.runCount) &&
    Number(value.runCount) >= 0 &&
    Number.isFinite(value.meanCentsSpent) &&
    Number.isFinite(value.maxCentsSpent) &&
    Number.isFinite(value.meanPurchases) &&
    (value.meanTimeToStopMs === null ||
      Number.isFinite(value.meanTimeToStopMs)) &&
    (value.falseBlocks === null ||
      (Number.isInteger(value.falseBlocks) && Number(value.falseBlocks) >= 0))
  );
}

function loadProgress(path: string): BenchmarkProgress {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read benchmark checkpoint: ${error instanceof Error ? error.message : "invalid JSON"}`,
    );
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Benchmark checkpoint must contain a JSON object");
  }
  const progress = value as Record<string, unknown>;
  const runs = progress.runs;
  const interruptedRuns = progress.interruptedRuns;
  const activeRun = progress.activeRun;
  const metrics = progress.metrics;
  if (
    progress.version !== 1 ||
    progress.stripeMode !== "test" ||
    typeof progress.generatedAt !== "string" ||
    typeof progress.complete !== "boolean" ||
    !Array.isArray(runs) ||
    !runs.every(isBenchmarkRun) ||
    !Array.isArray(interruptedRuns) ||
    !interruptedRuns.every(isBenchmarkRun) ||
    (activeRun !== null && !isBenchmarkPlanItem(activeRun)) ||
    (progress.completedAt !== undefined &&
      typeof progress.completedAt !== "string") ||
    (metrics !== undefined &&
      (!Array.isArray(metrics) || !metrics.every(isBenchmarkMetrics)))
  ) {
    throw new Error("Benchmark checkpoint has an unsupported or invalid format");
  }
  const planKeys = new Set(createBenchmarkPlan().map(planKey));
  const recordedKeys = [
    ...runs,
    ...interruptedRuns,
    ...(activeRun === null ? [] : [activeRun]),
  ].map(planKey);
  if (
    recordedKeys.some((key) => !planKeys.has(key)) ||
    new Set(recordedKeys).size !== recordedKeys.length
  ) {
    throw new Error("Benchmark checkpoint contains duplicate or unknown run entries");
  }
  return {
    version: 1,
    generatedAt: progress.generatedAt,
    stripeMode: "test",
    complete: progress.complete,
    runs,
    interruptedRuns,
    activeRun,
    ...(progress.completedAt === undefined
      ? {}
      : { completedAt: progress.completedAt }),
    ...(metrics === undefined ? {} : { metrics }),
  };
}

function planKey(item: BenchmarkPlanItem): string {
  return `${item.scenario}/${item.mode}/${item.run}`;
}

function saveProgress(path: string, progress: BenchmarkProgress): void {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, path);
}

function loadBenchmarkConfig(): BenchmarkConfig {
  const envPath = resolve(projectRoot, ".env");
  const fileEnvironment = existsSync(envPath)
    ? parse(
        readFileSync(envPath, "utf8")
          .split(/\r?\n/)
          .filter((line) => {
            const assignment = line.match(
              /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/,
            );
            return assignment !== null && allowedEnvironmentNames.has(assignment[1]);
          })
          .join("\n"),
      )
    : {};
  const get = (name: string): string | undefined =>
    process.env[name] ?? fileEnvironment[name];
  const adminKey = get("ADMIN_KEY")?.trim();
  if (!adminKey || adminKey.toLowerCase().startsWith("replace_with_")) {
    throw new Error("ADMIN_KEY must be configured in the root .env file");
  }
  const stripeSecretKey = get("STRIPE_SECRET_KEY")?.trim();
  if (!stripeSecretKey?.startsWith("sk_test_")) {
    throw new Error("Benchmark requires a Stripe test-mode key (sk_test_...)");
  }
  if (get("NODE_ENV")?.toLowerCase() === "production") {
    throw new Error("Benchmark refuses to run when NODE_ENV is production");
  }

  const buyer = loadBuyerConfig();
  const gatewayUrl = buyer.gatewayUrl;
  const sellerUrl = buyer.sellerUrl;
  for (const [label, address] of [
    ["GATEWAY_URL", gatewayUrl],
    ["SELLER_URL", sellerUrl],
  ]) {
    const hostname = new URL(address).hostname;
    if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
      throw new Error(`Benchmark requires ${label} to point to a local service`);
    }
  }

  return { adminKey, buyer, gatewayUrl, sellerUrl };
}

async function adminRequest<T>(
  config: BenchmarkConfig,
  path: string,
  options: AdminRequestOptions = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${config.gatewayUrl}/v1/admin${path}`, {
      method: options.method ?? "GET",
      headers: {
        "X-Admin-Key": config.adminKey,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(
      `Gateway admin request failed for ${path}: ${error instanceof Error ? error.message : "unknown network error"}`,
    );
  }
  const responseBody: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail =
      typeof responseBody === "object" &&
      responseBody !== null &&
      "message" in responseBody &&
      typeof responseBody.message === "string"
        ? responseBody.message
        : `HTTP ${response.status}`;
    throw new Error(`Gateway admin request failed for ${path}: ${detail}`);
  }
  if (responseBody === undefined) {
    throw new Error(`Gateway admin request returned invalid JSON for ${path}`);
  }
  return responseBody as T;
}

async function checkServices(config: BenchmarkConfig): Promise<void> {
  for (const [label, url] of [
    ["seller", config.sellerUrl],
    ["gateway", config.gatewayUrl],
  ]) {
    let response: Response;
    try {
      response = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      throw new Error(
        `${label} health check failed: ${error instanceof Error ? error.message : "unknown network error"}`,
      );
    }
    if (!response.ok) {
      throw new Error(`${label} health check failed with HTTP ${response.status}`);
    }
  }
  const { mode } = await adminRequest<{ mode: string }>(config, "/mode");
  if (mode !== "passthrough" && mode !== "guarded") {
    throw new Error("Gateway returned an invalid policy mode");
  }
}

async function setMode(
  config: BenchmarkConfig,
  mode: PolicyMode,
): Promise<void> {
  await adminRequest(config, "/mode", { method: "PUT", body: { mode } });
}

async function resetDemo(config: BenchmarkConfig): Promise<void> {
  await adminRequest(config, "/reset", { method: "POST" });
}

async function readSpentCents(
  config: BenchmarkConfig,
  agentId: string,
): Promise<number> {
  const response = await adminRequest<{ agents: AgentSummary[] }>(
    config,
    "/agents",
  );
  const agent = response.agents.find((candidate) => candidate.id === agentId);
  if (!agent || !Number.isFinite(agent.spent_today)) {
    throw new Error(`Benchmark buyer agent ${agentId} was not found`);
  }
  return agent.spent_today;
}

async function readSuccessfulPurchases(
  config: BenchmarkConfig,
  agentId: string,
): Promise<number> {
  const response = await adminRequest<{
    transactions: Array<{ agent_id: string; status: string }>;
  }>(config, "/transactions?limit=500");
  return response.transactions.filter(
    (transaction) =>
      transaction.agent_id === agentId && transaction.status === "succeeded",
  ).length;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function approvePendingBigPurchase(
  config: BenchmarkConfig,
  buyer: BuyerConfig,
  isFinished: () => boolean,
): Promise<void> {
  while (!isFinished()) {
    const response = await adminRequest<{ approvals: ApprovalSummary[] }>(
      config,
      "/approvals?status=pending",
    );
    for (const approval of response.approvals) {
      if (
        approval.agent_id === buyer.agentId &&
        approval.amount === 400 &&
        approval.resource_id === "premium-dataset"
      ) {
        await adminRequest(
          config,
          `/approvals/${encodeURIComponent(approval.approval_id)}/approve`,
          { method: "POST", body: { note: "T8 benchmark auto-approval" } },
        );
      }
    }
    await sleep(100);
  }
}

async function runScenario(
  config: BenchmarkConfig,
  scenario: ScenarioId,
): Promise<{
  purchases: number;
  timeToStopMs: number | null;
  stopReason: string;
  falseBlocks: number | null;
}> {
  const dependencies = {
    fetch,
    sleep,
    now: Date.now,
    log: (message: string) => console.error(message),
    pollIntervalMs: 100,
    maxPollDurationMs: 15_000,
  };
  if (scenario === "A") {
    const summary = await runBuyerScenario("runaway", config.buyer, dependencies);
    return {
      purchases: summary.purchases,
      timeToStopMs: summary.elapsedMs,
      stopReason: summary.stopReason,
      falseBlocks: null,
    };
  }
  if (scenario === "B") {
    let purchases = 0;
    const stopReasons: string[] = [];
    for (let purchase = 0; purchase < mixedPurchaseCount; purchase += 1) {
      const summary = await runBuyerScenario("happy", config.buyer, dependencies);
      purchases += summary.purchases;
      if (summary.purchases !== 1) {
        if (!isPolicyDenialReason(summary.stopReason)) {
          throw new Error(
            `Scenario B purchase ${purchase + 1} failed outside policy enforcement: ${summary.stopReason}`,
          );
        }
        stopReasons.push(summary.stopReason);
      }
      if (purchase + 1 < mixedPurchaseCount) {
        await sleep(mixedPurchaseDelayMs);
      }
    }
    return {
      purchases,
      timeToStopMs: null,
      stopReason: stopReasons.join(",") || "SCENARIO_COMPLETED",
      falseBlocks: mixedPurchaseCount - purchases,
    };
  }

  let finished = false;
  const buyerTask = runBuyerScenario("approval", config.buyer, dependencies).finally(
    () => {
      finished = true;
    },
  );
  const approvalTask = approvePendingBigPurchase(
    config,
    config.buyer,
    () => finished,
  );
  const [buyerResult, approvalResult] = await Promise.allSettled([
    buyerTask,
    approvalTask,
  ]);
  if (buyerResult.status === "rejected") {
    throw buyerResult.reason;
  }
  if (approvalResult.status === "rejected") {
    throw approvalResult.reason;
  }
  return {
    purchases: buyerResult.value.purchases,
    timeToStopMs: null,
    stopReason: buyerResult.value.stopReason,
    falseBlocks: null,
  };
}

async function executeBenchmark(
  config: BenchmarkConfig,
  progress: BenchmarkProgress,
  saveCheckpoint: () => void,
  onStateReset: () => void,
): Promise<void> {
  const remaining = getPendingBenchmarkPlan(
    progress.runs,
    progress.interruptedRuns,
  );
  console.log(
    `Starting benchmark: ${remaining.length} unattempted runs; ${progress.runs.length} completed and ${progress.interruptedRuns.length} interrupted runs retained.`,
  );
  for (const item of remaining) {
    await resetDemo(config);
    onStateReset();
    await setMode(config, item.mode);
    progress.activeRun = item;
    saveCheckpoint();
    const result = await runScenario(config, item.scenario);
    const centsSpent = await readSpentCents(config, config.buyer.agentId);
    if (item.scenario === "C" && result.purchases !== 1) {
      throw new Error(
        `Scenario C ${item.mode} run ${item.run} did not complete: ${result.stopReason}`,
      );
    }
    progress.runs.push({ ...item, ...result, centsSpent });
    progress.activeRun = null;
    saveCheckpoint();
    console.log(
      `${item.scenario}/${item.mode} ${item.run}/${runsPerScenario}: ${centsSpent} cents, ${result.purchases} purchases`,
    );
  }
}

function printDryRun(): void {
  const plan = createBenchmarkPlan();
  console.log(
    `Dry run only: ${plan.length} benchmark runs; no network requests or files changed.`,
  );
  console.log(
    "Passthrough scenario A alone can attempt 50,000 cents; the full suite can create up to about 71,000 cents in test payments. The confirmed run resets local gateway demo data.",
  );
  console.log("Start a live benchmark with: npm run bench -- --confirm");
  console.log("Resume an interrupted benchmark with: npm run bench -- --resume");
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes("--dry-run")) {
    printDryRun();
    return;
  }
  if (args.length !== 1 || !["--confirm", "--resume"].includes(args[0])) {
    throw new Error(
      "Usage: npm run bench -- --dry-run | npm run bench -- --confirm | npm run bench -- --resume",
    );
  }

  const config = loadBenchmarkConfig();
  await checkServices(config);
  const resultsPath = resolve(projectRoot, "results.json");
  let progress: BenchmarkProgress;
  if (args[0] === "--resume") {
    if (!existsSync(resultsPath)) {
      throw new Error("No benchmark checkpoint exists to resume");
    }
    progress = loadProgress(resultsPath);
    if (progress.complete) {
      throw new Error("The benchmark checkpoint is already complete");
    }
    if (progress.activeRun !== null) {
      const activeRun = progress.activeRun;
      const [centsSpent, purchases] = await Promise.all([
        readSpentCents(config, config.buyer.agentId),
        readSuccessfulPurchases(config, config.buyer.agentId),
      ]);
      progress.interruptedRuns.push({
        ...activeRun,
        centsSpent,
        purchases,
        timeToStopMs: null,
        falseBlocks: null,
        stopReason: "INTERRUPTED_AFTER_RESTART",
      });
      progress.activeRun = null;
      saveProgress(resultsPath, progress);
      console.log(
        `Recorded interrupted ${planKey(activeRun)}: ${centsSpent} cents, ${purchases} successful purchases; it will not be replayed.`,
      );
    }
  } else {
    if (existsSync(resultsPath)) {
      throw new Error(
        "results.json already exists; use --resume to continue its benchmark or archive it before starting a fresh run",
      );
    }
    progress = {
      version: 1,
      generatedAt: new Date().toISOString(),
      stripeMode: "test",
      complete: false,
      runs: [],
      interruptedRuns: [],
      activeRun: null,
    };
    saveProgress(resultsPath, progress);
  }
  let stateChanged = false;
  let benchmarkError: unknown;
  try {
    await executeBenchmark(
      config,
      progress,
      () => saveProgress(resultsPath, progress),
      () => {
        stateChanged = true;
      },
    );
    const metrics = summarizeBenchmarkRuns(progress.runs);
    const generatedAt = new Date().toISOString();
    progress.complete = true;
    progress.completedAt = generatedAt;
    progress.metrics = metrics;
    saveProgress(resultsPath, progress);
    writeFileSync(
      resolve(projectRoot, "docs", "RESULTS.md"),
      renderResultsMarkdown(metrics, generatedAt, progress.interruptedRuns),
      "utf8",
    );
    console.log("Wrote docs/RESULTS.md and results.json");
  } catch (error) {
    benchmarkError = error;
    throw error;
  } finally {
    if (stateChanged) {
      try {
        await setMode(config, "guarded");
      } catch (restoreError) {
        if (benchmarkError !== undefined) {
          throw new AggregateError(
            [benchmarkError, restoreError],
            "Benchmark failed and guarded mode could not be restored",
          );
        }
        throw restoreError;
      }
    }
  }
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entryPoint === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(
      `BENCHMARK_FAILED: ${error instanceof Error ? error.message : "Unexpected error"}`,
    );
    process.exitCode = 1;
  });
}
