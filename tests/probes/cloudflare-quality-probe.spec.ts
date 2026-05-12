import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_GAME_URL = "https://giuseppelevibo.github.io/game-network/single-file-chess-game/index.html";
const DEFAULT_SIGNALING_URL = "wss://game-network.giuseppe-levi.workers.dev/ws";

const durationMs = readEnvNumber("GAME_NETWORK_PROBE_DURATION_MS", 300_000);
const warmupMs = readEnvNumber("GAME_NETWORK_PROBE_WARMUP_MS", 60_000);
const windowMs = readEnvNumber("GAME_NETWORK_PROBE_WINDOW_MS", 30_000);
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
  clockOffsetSpreadMs: number | null;
}

interface WindowSummary {
  startMs: number;
  endMs: number;
  samples: number;
  probes: number;
  rttP50Ms: number | null;
  rttP95Ms: number | null;
  oneWayP50Ms: number | null;
  oneWayP95Ms: number | null;
  jitterP50Ms: number | null;
  jitterP95Ms: number | null;
  lateProbeCount: number;
  lateProbeRate: number;
  worstLateProbeMs: number | null;
  clockOffsetSpreadMs: number | null;
}

interface LateProbeDetail {
  source: string;
  role: string;
  sinceResetMs: number | null;
  direction: string;
  slackMs: number;
  oneWayDelayMs: number | null;
  lookaheadMs: number | null;
  scheduledAt: number | null;
  sentAt: number | null;
  receivedAt: number | null;
  sendLeadMs: number | null;
  sendToReceiveMs: number | null;
  receiveAfterScheduleMs: number | null;
}

interface ProbeSummary {
  room: string;
  durationMs: number;
  warmupMs: number;
  windowMs: number;
  gameUrl: string;
  signalingUrl: string;
  outputDir: string;
  hostSnapshot: Record<string, string>;
  guestSnapshot: Record<string, string>;
  host: EndpointSummary;
  guest: EndpointSummary;
  hostWindows: WindowSummary[];
  guestWindows: WindowSummary[];
  hostLateProbeDetails: LateProbeDetail[];
  guestLateProbeDetails: LateProbeDetail[];
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
  const hostWindows = summarizeWindows(hostRows, options.warmupMs, options.durationMs, windowMs);
  const guestWindows = summarizeWindows(guestRows, options.warmupMs, options.durationMs, windowMs);
  const hostLateProbeDetails = lateProbeDetails(hostRows, options.warmupMs, 12);
  const guestLateProbeDetails = lateProbeDetails(guestRows, options.warmupMs, 12);
  const timelineComparison = compareTimelines(hostRows, guestRows, options.warmupMs);
  return {
    room: options.room,
    durationMs: options.durationMs,
    warmupMs: options.warmupMs,
    windowMs,
    gameUrl: options.gameUrl,
    signalingUrl: options.signalingUrl,
    outputDir: options.outputDir,
    hostSnapshot: options.hostSnapshot,
    guestSnapshot: options.guestSnapshot,
    host,
    guest,
    hostWindows,
    guestWindows,
    hostLateProbeDetails,
    guestLateProbeDetails,
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
  const clockOffsets = samples.map((row) => numeric(row.stabilityMs)).filter(Number.isFinite);
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
    clockOffsetSpreadMs: spread(clockOffsets),
  };
}

function summarizeWindows(rows: CsvRow[], startMs: number, endMs: number, sizeMs: number): WindowSummary[] {
  const windows: WindowSummary[] = [];
  for (let start = startMs; start < endMs; start += sizeMs) {
    const end = Math.min(endMs, start + sizeMs);
    const samples = rows.filter(
      (row) => row.type === "sample" && row.source === "local" && numeric(row.sinceResetMs) >= start && numeric(row.sinceResetMs) < end,
    );
    const probes = rows.filter(
      (row) => row.type === "probe" && row.source === "local" && numeric(row.sinceResetMs) >= start && numeric(row.sinceResetMs) < end,
    );
    const probeSlacks = probes.map((row) => numeric(row.probeSlackMs)).filter(Number.isFinite);
    const lateProbeCount = probeSlacks.filter((value) => value < 0).length;
    const worstLateProbeMs =
      lateProbeCount > 0 ? Math.max(...probeSlacks.filter((value) => value < 0).map((value) => -value)) : null;
    const clockOffsets = samples.map((row) => numeric(row.stabilityMs)).filter(Number.isFinite);
    windows.push({
      startMs: start,
      endMs: end,
      samples: samples.length,
      probes: probes.length,
      rttP50Ms: summarize(samples, "rttMs").p50,
      rttP95Ms: summarize(samples, "rttMs").p95,
      oneWayP50Ms: summarize(samples, "oneWayDelayMs").p50,
      oneWayP95Ms: summarize(samples, "oneWayDelayMs").p95,
      jitterP50Ms: summarize(samples, "oneWayJitterMs").p50,
      jitterP95Ms: summarize(samples, "oneWayJitterMs").p95,
      lateProbeCount,
      lateProbeRate: probes.length > 0 ? lateProbeCount / probes.length : 0,
      worstLateProbeMs,
      clockOffsetSpreadMs: spread(clockOffsets),
    });
  }
  return windows;
}

function lateProbeDetails(rows: CsvRow[], warmupMs: number, limit: number): LateProbeDetail[] {
  return rows
    .filter((row) => row.type === "probe" && numeric(row.sinceResetMs) >= warmupMs && numeric(row.probeSlackMs) < 0)
    .map((row) => {
      const scheduledAt = nullableNumber(row.probeScheduledAt);
      const sentAt = nullableNumber(row.sentAt);
      const receivedAt = nullableNumber(row.receivedAt);
      const oneWayDelayMs = nullableNumber(row.oneWayDelayMs);
      return {
        source: row.source ?? "",
        role: row.role ?? "",
        sinceResetMs: nullableNumber(row.sinceResetMs),
        direction: row.probeDirection ?? "",
        slackMs: numeric(row.probeSlackMs),
        oneWayDelayMs,
        lookaheadMs: nullableNumber(row.probeLookaheadMs),
        scheduledAt,
        sentAt,
        receivedAt,
        sendLeadMs: scheduledAt !== null && sentAt !== null ? scheduledAt - sentAt : null,
        sendToReceiveMs: sentAt !== null && receivedAt !== null ? receivedAt - sentAt : oneWayDelayMs,
        receiveAfterScheduleMs: scheduledAt !== null && receivedAt !== null ? receivedAt - scheduledAt : null,
      };
    })
    .sort((a, b) => Math.abs(b.slackMs) - Math.abs(a.slackMs))
    .slice(0, limit);
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

function nullableNumber(value: string | undefined): number | null {
  const parsed = numeric(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function classifyQuality(host: EndpointSummary, guest: EndpointSummary, timeline: MetricSummary): string {
  const lateRate = Math.max(host.lateProbeRate, guest.lateProbeRate);
  const worstLate = Math.max(host.worstLateProbeMs ?? 0, guest.worstLateProbeMs ?? 0);
  const rttP95 = Math.max(host.rttMs.p95 ?? Number.POSITIVE_INFINITY, guest.rttMs.p95 ?? Number.POSITIVE_INFINITY);
  const oneWayP95 = Math.max(host.oneWayDelayMs.p95 ?? Number.POSITIVE_INFINITY, guest.oneWayDelayMs.p95 ?? Number.POSITIVE_INFINITY);
  const batchP95 = Math.max(
    host.telemetryBatchOneWayMs.p95 ?? Number.POSITIVE_INFINITY,
    guest.telemetryBatchOneWayMs.p95 ?? Number.POSITIVE_INFINITY,
  );
  void timeline;
  if (lateRate < 0.01 && worstLate < 20 && rttP95 < 60 && oneWayP95 < 35 && batchP95 < 100) return "GOOD";
  if (lateRate < 0.05 && worstLate < 80 && rttP95 < 120 && oneWayP95 < 60 && batchP95 < 250) return "PLAYABLE";
  return "UNSTABLE";
}

function renderConsoleSummary(summary: ProbeSummary): string {
  return [
    `Cloudflare probe ${summary.room}: ${summary.quality}`,
    `output: ${summary.outputDir}`,
    `clock offset p50: host ${format(summary.host.stabilityMs.p50)} ms, guest ${format(summary.guest.stabilityMs.p50)} ms`,
    `clock offset spread: host ${format(summary.host.clockOffsetSpreadMs)} ms, guest ${format(summary.guest.clockOffsetSpreadMs)} ms`,
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
- Window size: ${Math.round(summary.windowMs / 1000)} s
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

### Host Windows

${renderWindowsMarkdown(summary.hostWindows)}

### Host Worst Late Probes

${renderLateProbeDetailsMarkdown(summary.hostLateProbeDetails)}

## Guest

${renderEndpointMarkdown(summary.guest)}

### Guest Windows

${renderWindowsMarkdown(summary.guestWindows)}

### Guest Worst Late Probes

${renderLateProbeDetailsMarkdown(summary.guestLateProbeDetails)}
`;
}

function renderEndpointMarkdown(summary: EndpointSummary): string {
  return `| Metric | Value |
| --- | ---: |
| samples | ${summary.samples} |
| probes | ${summary.probes} |
| clock offset estimate p50 / p95 / p99 | ${format(summary.stabilityMs.p50)} / ${format(summary.stabilityMs.p95)} / ${format(summary.stabilityMs.p99)} ms |
| clock offset estimate spread | ${format(summary.clockOffsetSpreadMs)} ms |
| RTT p50 / p95 / p99 | ${format(summary.rttMs.p50)} / ${format(summary.rttMs.p95)} / ${format(summary.rttMs.p99)} ms |
| one-way p50 / p95 / p99 | ${format(summary.oneWayDelayMs.p50)} / ${format(summary.oneWayDelayMs.p95)} / ${format(summary.oneWayDelayMs.p99)} ms |
| jitter p50 / p95 / p99 | ${format(summary.oneWayJitterMs.p50)} / ${format(summary.oneWayJitterMs.p95)} / ${format(summary.oneWayJitterMs.p99)} ms |
| lookahead p50 / p95 / p99 | ${format(summary.adaptiveLookaheadMs.p50)} / ${format(summary.adaptiveLookaheadMs.p95)} / ${format(summary.adaptiveLookaheadMs.p99)} ms |
| probe slack p50 / p95 / min | ${format(summary.probeSlackMs.p50)} / ${format(summary.probeSlackMs.p95)} / ${format(summary.probeSlackMs.min)} ms |
| late probes | ${summary.lateProbeCount} (${(summary.lateProbeRate * 100).toFixed(1)}%) |
| worst late probe | ${format(summary.worstLateProbeMs)} ms |
| telemetry batch p95 / p99 / max | ${format(summary.telemetryBatchOneWayMs.p95)} / ${format(summary.telemetryBatchOneWayMs.p99)} / ${format(summary.telemetryBatchOneWayMs.max)} ms |`;
}

function renderWindowsMarkdown(windows: WindowSummary[]): string {
  const rows = windows
    .map(
      (window) =>
        `| ${Math.round(window.startMs / 1000)}-${Math.round(window.endMs / 1000)} | ${window.samples} | ${format(window.rttP50Ms)} / ${format(window.rttP95Ms)} | ${format(window.oneWayP50Ms)} / ${format(window.oneWayP95Ms)} | ${format(window.jitterP50Ms)} / ${format(window.jitterP95Ms)} | ${window.lateProbeCount} (${(window.lateProbeRate * 100).toFixed(1)}%) | ${format(window.worstLateProbeMs)} | ${format(window.clockOffsetSpreadMs)} |`,
    )
    .join("\n");
  return `| Window (s) | Samples | RTT p50/p95 | OW p50/p95 | Jitter p50/p95 | Late probes | Worst late | Offset spread |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}`;
}

function renderLateProbeDetailsMarkdown(details: LateProbeDetail[]): string {
  if (details.length === 0) return "No late probes after warm-up.";
  const rows = details
    .map(
      (detail) =>
        `| ${format(detail.sinceResetMs)} | ${detail.source} | ${detail.role} | ${detail.direction} | ${format(detail.slackMs)} | ${format(detail.lookaheadMs)} | ${format(detail.oneWayDelayMs)} | ${format(detail.sendLeadMs)} | ${format(detail.sendToReceiveMs)} | ${format(detail.receiveAfterScheduleMs)} |`,
    )
    .join("\n");
  return `| Since reset (ms) | Source | Role | Direction | Slack | Lookahead | One-way | Send lead | Sent to received | Received after schedule |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}`;
}

function format(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "--" : value.toFixed(2);
}

function spread(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.max(...values) - Math.min(...values);
}
