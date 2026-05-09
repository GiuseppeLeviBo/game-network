#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const warmupArg = args.find((arg) => arg.startsWith("--warmup-ms="));
const warmupMs = Number(warmupArg?.split("=")[1] ?? 60000);
const files = args.filter((arg) => !arg.startsWith("--"));

if (files.length === 0) {
  console.error("Usage: npm run analyze:telemetry -- [--warmup-ms=60000] host.csv guest.csv");
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
}

if (datasets.length >= 2) {
  printTimelineComparison(datasets[0], datasets[1], warmupMs);
}

function printDatasetSummary(dataset, warmupMs) {
  const role = dataset.rows.find((row) => row.role)?.role ?? "unknown";
  console.log(`\n## ${dataset.file} (${role})`);
  console.log(`Warm-up discarded: ${warmupMs} ms`);
  console.log(`Samples: ${dataset.samples.length}`);
  console.log(`Probes: ${dataset.probes.length}`);

  for (const metric of [
    "rttMs",
    "bestRttMs",
    "stabilityMs",
    "oneWayDelayMs",
    "oneWayJitterMs",
    "adaptiveLookaheadMs",
    "probeSlackMs",
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

function numericValues(rows, key) {
  return rows.map((row) => number(row[key])).filter(Number.isFinite);
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
