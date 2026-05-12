import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_GAME_URL = "https://giuseppelevibo.github.io/game-network/single-file-chess-game/index.html";
const DEFAULT_SIGNALING_URL = "wss://game-network.giuseppe-levi.workers.dev/ws";

const durationMs = readEnvNumber("GAME_NETWORK_PROBE_DURATION_MS", 300_000);
const warmupMs = readEnvNumber("GAME_NETWORK_PROBE_WARMUP_MS", 60_000);
const outputRoot = process.env.GAME_NETWORK_PROBE_OUTPUT_DIR ?? "Notes/cloudflare-probe";
const gameUrl = process.env.GAME_NETWORK_PROBE_URL ?? DEFAULT_GAME_URL;
const signalingBaseUrl = process.env.GAME_NETWORK_SIGNALING_URL ?? DEFAULT_SIGNALING_URL;

test("Cloudflare WebSocket relay quality probe", async ({ browser }, testInfo) => {
  test.setTimeout(durationMs + 120_000);

  const room = process.env.GAME_NETWORK_PROBE_ROOM ?? `CF-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const hostPeerId = `chess-host-${room}`;
  const guestPeerId = `chess-guest-${room}`;
  const signalingUrl = withRoom(signalingBaseUrl, room);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = join(outputRoot, `${runId}-${room}`);

  await mkdir(outputDir, { recursive: true });

  const context = await browser.newContext();
  const host = await context.newPage();
  const guest = await context.newPage();
  const pageLogs: string[] = [];
  for (const [label, page] of [["host", host], ["guest", guest]] as const) {
    page.on("console", (message) => pageLogs.push(`${label} console ${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => pageLogs.push(`${label} pageerror: ${error.message}`));
  }

  try {
    await host.goto(buildChessUrl({ role: "host", room, peer: hostPeerId, signalingUrl }));
    await guest.goto(buildChessUrl({ role: "guest", room, peer: guestPeerId, hostPeer: hostPeerId, signalingUrl }));

    await waitForNetworkReady(host);
    await waitForNetworkReady(guest);
    await waitForProbeSamples(host);
    await waitForProbeSamples(guest);

    await host.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__?.resetTelemetry());
    await guest.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__?.resetTelemetry());

    await host.waitForTimeout(durationMs);

    const hostCsv = await readTelemetryCsv(host);
    const guestCsv = await readTelemetryCsv(guest);
    const hostJson = await readTelemetryJson(host);
    const guestJson = await readTelemetryJson(guest);
    const hostSnapshot = await readSnapshot(host);
    const guestSnapshot = await readSnapshot(guest);

    const hostCsvPath = join(outputDir, `${room}-host.csv`);
    const guestCsvPath = join(outputDir, `${room}-guest.csv`);
    const hostJsonPath = join(outputDir, `${room}-host.json`);
    const guestJsonPath = join(outputDir, `${room}-guest.json`);
    const summaryJsonPath = join(outputDir, "summary.json");
    const summaryMdPath = join(outputDir, "summary.md");

    await writeFile(hostCsvPath, hostCsv, "utf8");
    await writeFile(guestCsvPath, guestCsv, "utf8");
    await writeFile(hostJsonPath, JSON.stringify(hostJson, null, 2), "utf8");
    await writeFile(guestJsonPath, JSON.stringify(guestJson, null, 2), "utf8");

    const summary = buildSummary({
      room,
      durationMs,
      warmupMs,
      gameUrl,
      signalingUrl,
      hostSnapshot,
      guestSnapshot,
      hostCsv,
      guestCsv,
      outputDir,
    });
    await writeFile(summaryJsonPath, JSON.stringify(summary, null, 2), "utf8");
    await writeFile(summaryMdPath, renderSummaryMarkdown(summary), "utf8");

    await testInfo.attach("cloudflare-probe-summary", {
      path: summaryMdPath,
      contentType: "text/markdown",
    });
    await testInfo.attach("cloudflare-probe-summary-json", {
      path: summaryJsonPath,
      contentType: "application/json",
    });

    console.log(renderConsoleSummary(summary));
  } finally {
    if (pageLogs.length > 0) {
      await writeFile(join(outputDir, "browser-console.log"), pageLogs.join("\n"), "utf8");
    }
    await context.close();
  }
});

function buildChessUrl(options: {
  role: "host" | "guest";
  room: string;
  peer: string;
  hostPeer?: string;
  signalingUrl: string;
}): string {
  const url = new URL(gameUrl);
  url.searchParams.set("transport", "websocket");
  url.searchParams.set("role", options.role);
  url.searchParams.set("room", options.room);
  url.searchParams.set("peer", options.peer);
  url.searchParams.set("signaling", options.signalingUrl);
  if (options.hostPeer) url.searchParams.set("host", options.hostPeer);
  return url.toString();
}

function withRoom(signalingUrl: string, room: string): string {
  const url = new URL(signalingUrl);
  url.searchParams.set("room", room);
  return url.toString();
}

async function waitForNetworkReady(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__?.getSnapshot().remotePeer ?? "--"), {
      timeout: 60_000,
    })
    .not.toBe("--");
  await expect
    .poll(() => page.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__?.getSnapshot().rtt ?? "--"), {
      timeout: 90_000,
    })
    .not.toBe("--");
}

async function waitForProbeSamples(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__?.getSnapshot().probeSamples ?? "0"), {
      timeout: 90_000,
    })
    .not.toBe("0");
}

async function readTelemetryCsv(page: Page): Promise<string> {
  return page.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__.getTelemetryCsv());
}

async function readTelemetryJson(page: Page): Promise<unknown> {
  return page.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__.getTelemetry());
}

async function readSnapshot(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => window.__CHESS_NETWORK_DIAGNOSTICS__.getSnapshot());
}

function readEnvNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

interface CsvRow {
  [key: string]: string;
}

interface MetricSummary {
  n: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

interface EndpointSummary {
  samples: number;
  probes: number;
  rttMs: MetricSummary;
  bestRttMs: MetricSummary;
  stabilityMs: MetricSummary;
  oneWayDelayMs: MetricSummary;
  oneWayJitterMs: MetricSummary;
  adaptiveLookaheadMs: MetricSummary;
  probeSlackMs: MetricSummary;
  probeOneWayDelayMs: MetricSummary;
  telemetryBatchOneWayMs: MetricSummary;
  lateProbeCount: number;
  lateProbeRate: number;
  worstLateProbeMs: number | null;
}

interface ProbeSummary {
  room: string;
  durationMs: number;
  warmupMs: number;
  gameUrl: string;
  signalingUrl: string;
  outputDir: string;
  hostSnapshot: Record<string, string>;
  guestSnapshot: Record<string, string>;
  host: EndpointSummary;
  guest: EndpointSummary;
  timelineComparison: MetricSummary;
  quality: string;
}

function buildSummary(options: {
  room: string;
  durationMs: number;
  warmupMs: number;
  gameUrl: string;
  signalingUrl: string;
  hostSnapshot: Record<string, string>;
  guestSnapshot: Record<string, string>;
  hostCsv: string;
  guestCsv: string;
  outputDir: string;
}): ProbeSummary {
  const hostRows = parseCsv(options.hostCsv);
  const guestRows = parseCsv(options.guestCsv);
  const host = summarizeEndpoint(hostRows, options.warmupMs);
  const guest = summarizeEndpoint(guestRows, options.warmupMs);
  const timelineComparison = compareTimelines(hostRows, guestRows, options.warmupMs);
  return {
    room: options.room,
    durationMs: options.durationMs,
    warmupMs: options.warmupMs,
    gameUrl: options.gameUrl,
    signalingUrl: options.signalingUrl,
    outputDir: options.outputDir,
    hostSnapshot: options.hostSnapshot,
    guestSnapshot: options.guestSnapshot,
    host,
    guest,
    timelineComparison,
    quality: classifyQuality(host, guest, timelineComparison),
  };
}

function parseCsv(csv: string): CsvRow[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length <= 1) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).filter(Boolean).map((line) => {
    const cells = line.split(",");
    const row: CsvRow = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? "";
    });
    return row;
  });
}

function summarizeEndpoint(rows: CsvRow[], warmupMs: number): EndpointSummary {
  const samples = rows.filter((row) => row.type === "sample" && numeric(row.sinceResetMs) >= warmupMs);
  const probes = rows.filter((row) => row.type === "probe" && numeric(row.sinceResetMs) >= warmupMs);
  const batches = rows.filter((row) => Number.isFinite(numeric(row.batchOneWayDelayMs)));
  const probeSlacks = probes.map((row) => numeric(row.probeSlackMs)).filter(Number.isFinite);
  const lateProbeCount = probeSlacks.filter((value) => value < 0).length;
  const worstLateProbeMs = lateProbeCount > 0 ? Math.max(...probeSlacks.filter((value) => value < 0).map((value) => -value)) : null;

  return {
    samples: samples.length,
    probes: probes.length,
    rttMs: summarize(samples, "rttMs"),
    bestRttMs: summarize(samples, "bestRttMs"),
    stabilityMs: summarize(samples, "stabilityMs"),
    oneWayDelayMs: summarize(samples, "oneWayDelayMs"),
    oneWayJitterMs: summarize(samples, "oneWayJitterMs"),
    adaptiveLookaheadMs: summarize(samples, "adaptiveLookaheadMs"),
    probeSlackMs: summarizeValues(probeSlacks),
    probeOneWayDelayMs: summarize(probes, "oneWayDelayMs"),
    telemetryBatchOneWayMs: summarize(batches, "batchOneWayDelayMs"),
    lateProbeCount,
    lateProbeRate: probes.length > 0 ? lateProbeCount / probes.length : 0,
    worstLateProbeMs,
  };
}

function compareTimelines(hostRows: CsvRow[], guestRows: CsvRow[], warmupMs: number): MetricSummary {
  const hostSamples = hostRows
    .filter((row) => row.source === "local" && row.type === "sample" && numeric(row.sinceResetMs) >= warmupMs)
    .map((row) => ({ wallMs: numeric(row.wallMs), timelineMs: numeric(row.timelineMs) }))
    .filter((row) => Number.isFinite(row.wallMs) && Number.isFinite(row.timelineMs));
  const guestSamples = guestRows
    .filter((row) => row.source === "local" && row.type === "sample" && numeric(row.sinceResetMs) >= warmupMs)
    .map((row) => ({ wallMs: numeric(row.wallMs), timelineMs: numeric(row.timelineMs) }))
    .filter((row) => Number.isFinite(row.wallMs) && Number.isFinite(row.timelineMs));

  const deltas: number[] = [];
  let guestIndex = 0;
  for (const host of hostSamples) {
    while (
      guestIndex + 1 < guestSamples.length &&
      Math.abs(guestSamples[guestIndex + 1].wallMs - host.wallMs) <= Math.abs(guestSamples[guestIndex].wallMs - host.wallMs)
    ) {
      guestIndex += 1;
    }
    const guest = guestSamples[guestIndex];
    if (!guest || Math.abs(guest.wallMs - host.wallMs) > 150) continue;
    deltas.push(Math.abs(host.timelineMs - guest.timelineMs));
  }
  return summarizeValues(deltas);
}

function summarize(rows: CsvRow[], field: string): MetricSummary {
  return summarizeValues(rows.map((row) => numeric(row[field])).filter(Number.isFinite));
}

function summarizeValues(values: number[]): MetricSummary {
  if (values.length === 0) {
    return { n: 0, min: null, p50: null, p95: null, p99: null, max: null, mean: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    n: values.length,
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
    mean,
  };
}

function percentile(sortedValues: number[], p: number): number {
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor((sortedValues.length - 1) * p))];
}

function numeric(value: string | undefined): number {
  if (value === undefined || value === "") return Number.NaN;
  return Number(value);
}

function classifyQuality(host: EndpointSummary, guest: EndpointSummary, timeline: MetricSummary): string {
  const lateRate = Math.max(host.lateProbeRate, guest.lateProbeRate);
  const worstLate = Math.max(host.worstLateProbeMs ?? 0, guest.worstLateProbeMs ?? 0);
  const syncStability = Math.max(stabilityBound(host.stabilityMs), stabilityBound(guest.stabilityMs));
  void timeline;
  if (syncStability <= 10 && lateRate < 0.01 && worstLate < 20) return "GOOD";
  if (syncStability <= 10 && lateRate < 0.05 && worstLate < 80) return "PLAYABLE";
  return "UNSTABLE";
}

function renderConsoleSummary(summary: ProbeSummary): string {
  return [
    `Cloudflare probe ${summary.room}: ${summary.quality}`,
    `output: ${summary.outputDir}`,
    `sync stability p99: host ${format(summary.host.stabilityMs.p99)} ms, guest ${format(summary.guest.stabilityMs.p99)} ms`,
    `sample-pair timeline delta p99: ${format(summary.timelineComparison.p99)} ms (sampling alignment, not clock error)`,
    `host late probes: ${summary.host.lateProbeCount}/${summary.host.probes} worst ${format(summary.host.worstLateProbeMs)} ms`,
    `guest late probes: ${summary.guest.lateProbeCount}/${summary.guest.probes} worst ${format(summary.guest.worstLateProbeMs)} ms`,
  ].join("\n");
}

function renderSummaryMarkdown(summary: ProbeSummary): string {
  return `# Cloudflare Probe ${summary.room}

Quality: **${summary.quality}**

- Duration: ${Math.round(summary.durationMs / 1000)} s
- Warm-up discarded: ${Math.round(summary.warmupMs / 1000)} s
- Game URL: ${summary.gameUrl}
- Signaling URL: ${summary.signalingUrl}

## Timeline

This is a nearest-sample comparison and is limited by the telemetry sampling
cadence. It is useful as a coarse diagnostic, not as the primary clock-error
metric.

| Metric | Value |
| --- | ---: |
| abs delta p50 | ${format(summary.timelineComparison.p50)} ms |
| abs delta p95 | ${format(summary.timelineComparison.p95)} ms |
| abs delta p99 | ${format(summary.timelineComparison.p99)} ms |
| abs delta max | ${format(summary.timelineComparison.max)} ms |

## Host

${renderEndpointMarkdown(summary.host)}

## Guest

${renderEndpointMarkdown(summary.guest)}
`;
}

function renderEndpointMarkdown(summary: EndpointSummary): string {
  return `| Metric | Value |
| --- | ---: |
| samples | ${summary.samples} |
| probes | ${summary.probes} |
| sync stability p50 / p95 / p99 | ${format(summary.stabilityMs.p50)} / ${format(summary.stabilityMs.p95)} / ${format(summary.stabilityMs.p99)} ms |
| RTT p50 / p95 / p99 | ${format(summary.rttMs.p50)} / ${format(summary.rttMs.p95)} / ${format(summary.rttMs.p99)} ms |
| one-way p50 / p95 / p99 | ${format(summary.oneWayDelayMs.p50)} / ${format(summary.oneWayDelayMs.p95)} / ${format(summary.oneWayDelayMs.p99)} ms |
| jitter p50 / p95 / p99 | ${format(summary.oneWayJitterMs.p50)} / ${format(summary.oneWayJitterMs.p95)} / ${format(summary.oneWayJitterMs.p99)} ms |
| lookahead p50 / p95 / p99 | ${format(summary.adaptiveLookaheadMs.p50)} / ${format(summary.adaptiveLookaheadMs.p95)} / ${format(summary.adaptiveLookaheadMs.p99)} ms |
| probe slack p50 / p95 / min | ${format(summary.probeSlackMs.p50)} / ${format(summary.probeSlackMs.p95)} / ${format(summary.probeSlackMs.min)} ms |
| late probes | ${summary.lateProbeCount} (${(summary.lateProbeRate * 100).toFixed(1)}%) |
| worst late probe | ${format(summary.worstLateProbeMs)} ms |
| telemetry batch p95 / p99 / max | ${format(summary.telemetryBatchOneWayMs.p95)} / ${format(summary.telemetryBatchOneWayMs.p99)} / ${format(summary.telemetryBatchOneWayMs.max)} ms |`;
}

function format(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "--" : value.toFixed(2);
}

function stabilityBound(summary: MetricSummary): number {
  const candidates = [summary.min, summary.p99, summary.max].filter((value): value is number => value !== null);
  return candidates.length > 0 ? Math.max(...candidates.map((value) => Math.abs(value))) : Number.POSITIVE_INFINITY;
}
