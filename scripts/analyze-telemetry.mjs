#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const warmupArg = args.find((arg) => arg.startsWith("--warmup-ms="));
const warmupMs = Number(warmupArg?.split("=")[1] ?? 60000);
const files = args.filter((arg) => !arg.startsWith("--"));

if (files.length === 0) {
  console.error("Usage: npm run analyze:telemetry -- [--warmup-ms=60000] host.csv [guest.csv]");
  process.exit(1);
}

const datasets = [];
for (const file of files) {
  const rows = parseCsv(await readFile(file, "utf8"));
  const samples = rows.filter((row) => row.type === "sample" && number(row.sinceResetMs) >= warmupMs);
  const probes = rows.filter((row) => row.type === "probe" && number(row.sinceResetMs) >= warmupMs);
  datasets.push({ file, rows, samples, probes });
}

for (const dataset of datasets) {
  printDatasetSummary(dataset, warmupMs);
  for (const sourceDataset of sourceDatasets(dataset, warmupMs)) {
    printDatasetSummary(sourceDataset, warmupMs);
  }
  printCombinedCollectorAnalysis(dataset, warmupMs);
}

if (datasets.length >= 2) {
  printTimelineComparison(datasets[0], datasets[1], warmupMs);
}

function printDatasetSummary(dataset, warmupMs) {
  const role = dataset.rows.find((row) => row.role)?.role ?? dataset.rows.find((row) => row.remoteRole)?.remoteRole ?? "unknown";
  console.log(`\n## ${dataset.file} (${role})`);
  console.log(`Warm-up discarded: ${warmupMs} ms`);
  console.log(`Samples: ${dataset.samples.length}`);
  console.log(`Probes: ${dataset.probes.length}`);

  for (const metric of [
    "rttMs",
    "bestRttMs",
    "clockOffsetMs",
    "clockStabilityMs",
    "stabilityMs",
    "oneWayDelayMs",
    "oneWayJitterMs",
    "adaptiveLookaheadMs",
    "probeSlackMs",
    "probeLateMs",
  ]) {
    const values = numericValues(dataset.samples, metric);
    if (values.length === 0) continue;
    const summary = summarize(values);
    console.log(
      `${metric}: n=${summary.n} min=${fmt(summary.min)} p50=${fmt(summary.p50)} p95=${fmt(summary.p95)} p99=${fmt(summary.p99)} max=${fmt(summary.max)} mean=${fmt(summary.mean)}`,
    );
  }

  const probeSlack = numericValues(dataset.probes, "probeSlackMs");
  if (probeSlack.length > 0) {
    const negative = probeSlack.filter((value) => value < 0).length;
    const summary = summarize(probeSlack);
    console.log(
      `probeSlack events: n=${summary.n} negative=${negative} min=${fmt(summary.min)} p50=${fmt(summary.p50)} p95=${fmt(summary.p95)} max=${fmt(summary.max)}`,
    );
  }

  const probeLate = probeLateValues(dataset.probes);
  if (probeLate.length > 0) {
    const late = probeLate.filter((value) => value > 0).length;
    const summary = summarize(probeLate);
    console.log(
      `probeLate events: n=${summary.n} late=${late} min=${fmt(summary.min)} p50=${fmt(summary.p50)} p95=${fmt(summary.p95)} max=${fmt(summary.max)}`,
    );
  }

  const batchOneWay = numericValues(dataset.rows, "batchOneWayDelayMs");
  if (batchOneWay.length > 0) {
    const summary = summarize(batchOneWay);
    console.log(
      `telemetryBatchOneWayMs: n=${summary.n} min=${fmt(summary.min)} p50=${fmt(summary.p50)} p95=${fmt(summary.p95)} max=${fmt(summary.max)}`,
    );
  }

  printVisibilitySummary(dataset.samples, dataset.probes);
}

function sourceDatasets(dataset, warmupMs) {
  const sources = [...new Set(dataset.rows.map((row) => row.source).filter(Boolean))];
  if (sources.length <= 1) return [];
  return sources.map((source) => {
    const rows = dataset.rows.filter((row) => row.source === source);
    return {
      file: `${dataset.file} [source=${source}]`,
      rows,
      samples: rows.filter((row) => row.type === "sample" && number(row.sinceResetMs) >= warmupMs),
      probes: rows.filter((row) => row.type === "probe" && number(row.sinceResetMs) >= warmupMs),
    };
  });
}

function printCombinedCollectorAnalysis(dataset, warmupMs) {
  const localSamples = dataset.rows.filter(
    (row) => row.source === "local" && row.type === "sample" && number(row.sinceResetMs) >= warmupMs,
  );
  const remoteSamples = dataset.rows.filter(
    (row) => row.source === "remote" && row.type === "sample" && number(row.sinceResetMs) >= warmupMs,
  );
  const localProbes = dataset.rows.filter(
    (row) => row.source === "local" && row.type === "probe" && number(row.sinceResetMs) >= warmupMs,
  );
  const remoteProbes = dataset.rows.filter(
    (row) => row.source === "remote" && row.type === "probe" && number(row.sinceResetMs) >= warmupMs,
  );
  const remoteRows = [...remoteSamples, ...remoteProbes];
  if (localSamples.length === 0 || remoteRows.length === 0) return;

  console.log(`\n## Combined collector analysis: ${dataset.file}`);
  console.log(`Warm-up discarded: ${warmupMs} ms`);
  console.log("Uses one collector CSV. Does not assume comparable OS wall clocks across machines.");
  console.log(`Local samples/probes: ${localSamples.length} / ${localProbes.length}`);
  console.log(`Remote samples/probes: ${remoteSamples.length} / ${remoteProbes.length}`);

  const batches = uniqueRemoteBatches(remoteRows);
  console.log(`Remote telemetry batches: ${batches.length}`);
  printMetricSummary("batchOneWayDelayMs", numericValues(batches, "batchOneWayDelayMs"));
  printCollectorLagSummary(batches);
  printRemoteSampleAgeSummary(remoteRows);

  const localRemoteTimelinePairs = pairByMetric(localSamples, remoteSamples, "timelineMs", 150);
  const timelineDistance = localRemoteTimelinePairs.map(([local, remote]) =>
    Math.abs(number(local.timelineMs) - number(remote.timelineMs)),
  );
  printMetricSummary("nearestTimelineSampleDistanceMs", timelineDistance);
  console.log(
    "nearestTimelineSampleDistanceMs is sampling alignment, not clock error; it should be read with the 250 ms sample cadence in mind.",
  );
}

function printTimelineComparison(left, right, warmupMs) {
  const pairs = pairSamples(left.samples, right.samples, 300);
  const deltas = pairs
    .map(([a, b]) => {
      const timelineA = number(a.timelineMs);
      const timelineB = number(b.timelineMs);
      const wallA = number(a.wallMs);
      const wallB = number(b.wallMs);
      if (![timelineA, timelineB, wallA, wallB].every(Number.isFinite)) return null;
      return timelineA - (timelineB + (wallA - wallB));
    })
    .filter((value) => value !== null);

  console.log(`\n## Timeline comparison`);
  console.log(`Warm-up discarded: ${warmupMs} ms`);
  console.log("Assumes both CSV files were captured on machines with comparable wall clocks.");
  console.log(`Paired samples: ${deltas.length}`);
  if (deltas.length === 0) return;

  const absolute = deltas.map(Math.abs);
  const signedSummary = summarize(deltas);
  const absoluteSummary = summarize(absolute);
  console.log(
    `signedDeltaMs: min=${fmt(signedSummary.min)} p50=${fmt(signedSummary.p50)} p95=${fmt(signedSummary.p95)} max=${fmt(signedSummary.max)} mean=${fmt(signedSummary.mean)}`,
  );
  console.log(
    `absDeltaMs: min=${fmt(absoluteSummary.min)} p50=${fmt(absoluteSummary.p50)} p95=${fmt(absoluteSummary.p95)} p99=${fmt(absoluteSummary.p99)} max=${fmt(absoluteSummary.max)} mean=${fmt(absoluteSummary.mean)}`,
  );
  console.log(`absDelta > 10 ms: ${absolute.filter((value) => value > 10).length}`);
}

function printMetricSummary(label, values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return;
  const summary = summarize(finite);
  console.log(
    `${label}: n=${summary.n} min=${fmt(summary.min)} p50=${fmt(summary.p50)} p95=${fmt(summary.p95)} p99=${fmt(summary.p99)} max=${fmt(summary.max)} mean=${fmt(summary.mean)}`,
  );
}

function printVisibilitySummary(samples, probes) {
  const hasVisibility = [...samples, ...probes].some(
    (row) => row.visibilityState || row.documentHidden || row.hasFocus,
  );
  if (!hasVisibility) return;

  const buckets = [
    ["foreground", (row) => row.visibilityState === "visible" && row.documentHidden !== "true" && row.hasFocus !== "false"],
    ["visible-unfocused", (row) => row.visibilityState === "visible" && row.hasFocus === "false"],
    ["hidden", (row) => row.visibilityState === "hidden" || row.documentHidden === "true"],
    ["unknown", (row) => !row.visibilityState && !row.documentHidden && !row.hasFocus],
  ];

  const parts = buckets
    .map(([label, predicate]) => {
      const sampleCount = samples.filter(predicate).length;
      const probeCount = probes.filter(predicate).length;
      if (sampleCount === 0 && probeCount === 0) return null;
      return `${label}: samples=${sampleCount} probes=${probeCount}`;
    })
    .filter(Boolean);
  if (parts.length === 0) return;
  console.log(`visibility: ${parts.join("; ")}`);

  for (const [label, predicate] of buckets) {
    const bucketSamples = samples.filter(predicate);
    const bucketProbes = probes.filter(predicate);
    if (bucketSamples.length === 0 && bucketProbes.length === 0) continue;

    const jitter = summarizeIfAny(numericValues(bucketSamples, "oneWayJitterMs"));
    const lookahead = summarizeIfAny(numericValues(bucketSamples, "adaptiveLookaheadMs"));
    const late = summarizeIfAny(probeLateValues(bucketProbes));
    const lateCount = probeLateValues(bucketProbes).filter((value) => value > 0).length;
    const fields = [];
    if (jitter) fields.push(`jitter p50=${fmt(jitter.p50)} p95=${fmt(jitter.p95)}`);
    if (lookahead) fields.push(`lookahead p50=${fmt(lookahead.p50)} p95=${fmt(lookahead.p95)}`);
    if (late) fields.push(`probeLate late=${lateCount}/${late.n} p95=${fmt(late.p95)} max=${fmt(late.max)}`);
    if (fields.length > 0) console.log(`visibility[${label}]: ${fields.join("; ")}`);
  }
}

function printCollectorLagSummary(batches) {
  const lagRows = batches
    .map((row) => {
      const collectorTimelineMs = number(row.collectorTimelineMs);
      const batchCreatedTimelineMs = number(row.batchCreatedTimelineMs);
      const batchOneWayDelayMs = number(row.batchOneWayDelayMs);
      if (![collectorTimelineMs, batchCreatedTimelineMs].every(Number.isFinite)) return null;
      const lagMs = collectorTimelineMs - batchCreatedTimelineMs;
      return {
        lagMs,
        residualMs: Number.isFinite(batchOneWayDelayMs) ? lagMs - batchOneWayDelayMs : Number.NaN,
      };
    })
    .filter(Boolean);
  if (lagRows.length === 0) return;

  const residuals = lagRows.map((row) => Math.abs(row.residualMs)).filter(Number.isFinite);
  if (residuals.length > 0 && summarize(residuals).p50 > 1000) {
    console.log(
      "batchCollectorLagMs: skipped because batchCreatedTimelineMs and collectorTimelineMs are not comparable in this file.",
    );
    console.log("Use batchOneWayDelayMs for this capture; future exports include a stricter batch timeline source.");
    return;
  }

  printMetricSummary("batchCollectorLagMs", lagRows.map((row) => row.lagMs));
  printMetricSummary("batchCollectorLagResidualMs", lagRows.map((row) => row.residualMs));
}

function printRemoteSampleAgeSummary(remoteRows) {
  const ages = remoteSampleAgeValues(remoteRows);
  if (ages.length === 0) return;
  if (summarize(ages.map(Math.abs)).p50 > 10000) {
    console.log(
      "remoteSampleAgeAtCollectorMs: skipped because remote row timelineMs and collectorTimelineMs are not comparable in this file.",
    );
    return;
  }
  printMetricSummary("remoteSampleAgeAtCollectorMs", ages);
}

function pairSamples(leftSamples, rightSamples, maxDistanceMs) {
  const right = [...rightSamples].sort((a, b) => number(a.wallMs) - number(b.wallMs));
  const pairs = [];
  let cursor = 0;
  for (const left of leftSamples) {
    const wall = number(left.wallMs);
    while (cursor + 1 < right.length && Math.abs(number(right[cursor + 1].wallMs) - wall) <= Math.abs(number(right[cursor].wallMs) - wall)) {
      cursor += 1;
    }
    const candidate = right[cursor];
    if (candidate && Math.abs(number(candidate.wallMs) - wall) <= maxDistanceMs) {
      pairs.push([left, candidate]);
    }
  }
  return pairs;
}

function pairByMetric(leftRows, rightRows, key, maxDistance) {
  const right = [...rightRows]
    .filter((row) => Number.isFinite(number(row[key])))
    .sort((a, b) => number(a[key]) - number(b[key]));
  const pairs = [];
  let cursor = 0;
  for (const left of leftRows) {
    const value = number(left[key]);
    if (!Number.isFinite(value) || right.length === 0) continue;
    while (
      cursor + 1 < right.length &&
      Math.abs(number(right[cursor + 1][key]) - value) <= Math.abs(number(right[cursor][key]) - value)
    ) {
      cursor += 1;
    }
    const candidate = right[cursor];
    if (candidate && Math.abs(number(candidate[key]) - value) <= maxDistance) {
      pairs.push([left, candidate]);
    }
  }
  return pairs;
}

function uniqueRemoteBatches(remoteRows) {
  const batchesByKey = new Map();
  for (const row of remoteRows) {
    const key = [
      row.collectorPeerId,
      row.remotePeerId,
      row.collectorWallMs,
      row.batchCreatedWallMs,
      row.batchReceivedAt,
    ].join("|");
    if (batchesByKey.has(key)) continue;
    batchesByKey.set(key, row);
  }
  return [...batchesByKey.values()];
}

function collectorLagValues(rows) {
  return rows
    .map((row) => {
      const collectorTimelineMs = number(row.collectorTimelineMs);
      const batchCreatedTimelineMs = number(row.batchCreatedTimelineMs);
      if (![collectorTimelineMs, batchCreatedTimelineMs].every(Number.isFinite)) return Number.NaN;
      return collectorTimelineMs - batchCreatedTimelineMs;
    })
    .filter(Number.isFinite);
}

function remoteSampleAgeValues(rows) {
  return rows
    .map((row) => {
      const collectorTimelineMs = number(row.collectorTimelineMs);
      const timelineMs = number(row.timelineMs);
      if (![collectorTimelineMs, timelineMs].every(Number.isFinite)) return Number.NaN;
      return collectorTimelineMs - timelineMs;
    })
    .filter(Number.isFinite);
}

function numericValues(rows, key) {
  return rows.map((row) => number(row[key])).filter(Number.isFinite);
}

function probeLateValues(rows) {
  return rows
    .map((row) => {
      const explicit = number(row.probeLateMs);
      if (Number.isFinite(explicit)) return explicit;
      const slack = number(row.probeSlackMs);
      return Number.isFinite(slack) && slack < 0 ? -slack : Number.isFinite(slack) ? 0 : Number.NaN;
    })
    .filter(Number.isFinite);
}

function summarizeIfAny(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? summarize(finite) : null;
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    n: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
    mean,
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function number(value) {
  if (value === null || value === undefined || value === "") return Number.NaN;
  return Number(value);
}

function fmt(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function parseCsv(text) {
  const rows = parseCsvRows(text.trim());
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}
