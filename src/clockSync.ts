import {
  createEnvelope,
  isProtocolEnvelope,
  type PeerId,
  type RoomId,
  type SyncRequestPayload,
  type SyncResponsePayload,
  type Unsubscribe,
} from "./protocol.js";
import type { GameNetworkTransport } from "./transport.js";

export type MonotonicClock = () => number;

export interface ClockSyncHostOptions {
  roomId: RoomId;
  transport: GameNetworkTransport;
  now?: MonotonicClock;
}

export interface ClockSyncClientOptions {
  roomId: RoomId;
  hostPeerId: PeerId;
  transport: GameNetworkTransport;
  now?: MonotonicClock;
  bestSampleRatio?: number;
  maxSamples?: number;
  offsetMadFactor?: number;
}

export interface ClockSyncSample {
  syncSeq: number;
  t1: number;
  t2: number;
  t3: number;
  t4: number;
  rttMs: number;
  offsetMs: number;
  errorBoundMs: number;
}

export interface ClockSyncEstimate {
  locked: boolean;
  sampleCount: number;
  selectedSampleCount: number;
  offsetMs: number;
  rttMs: number;
  bestRttMs: number;
  drift: number;
  interceptMs: number;
  updatedAt: number;
}

export interface ScheduledHostEvent {
  cancel(): void;
}

export interface ScheduledSyncBurst {
  cancel(): void;
}

export interface OneWayDelaySample {
  sentAt: number;
  receivedAt: number;
  rawDelayMs: number;
  delayMs: number;
  errorBoundMs?: number;
  label?: string;
}

export interface OneWayDelayEstimate {
  locked: boolean;
  sampleCount: number;
  delayMs: number;
  bestDelayMs: number;
  worstDelayMs: number;
  jitterMs: number;
  updatedAt: number;
}

export interface AdaptiveLookaheadOptions {
  minMs?: number;
  maxMs?: number;
  safetyMarginMs?: number;
  jitterMultiplier?: number;
  riseLimitMs?: number;
  fallLimitMs?: number;
  fallHoldSamples?: number;
  initialMs?: number;
}

export interface AdaptiveLookaheadInput {
  oneWayDelayMs?: number;
  oneWayJitterMs?: number;
  clockErrorBoundMs?: number;
  rttMs?: number;
}

export interface AdaptiveLookaheadEstimate {
  lookaheadMs: number;
  targetMs: number;
  clamped: boolean;
  stableSamples: number;
}

const DEFAULT_BEST_SAMPLE_RATIO = 0.25;
const DEFAULT_MAX_SAMPLES = 96;
const DEFAULT_ONE_WAY_MAX_SAMPLES = 120;
const DEFAULT_OFFSET_MAD_FACTOR = 3;
const DEFAULT_OFFSET_OUTLIER_FLOOR_MS = 1;
const DEFAULT_LOOKAHEAD_MIN_MS = 25;
const DEFAULT_LOOKAHEAD_MAX_MS = 120;
const DEFAULT_LOOKAHEAD_SAFETY_MARGIN_MS = 8;
const DEFAULT_LOOKAHEAD_JITTER_MULTIPLIER = 3;
const DEFAULT_LOOKAHEAD_RISE_LIMIT_MS = 20;
const DEFAULT_LOOKAHEAD_FALL_LIMIT_MS = 3;
const DEFAULT_LOOKAHEAD_FALL_HOLD_SAMPLES = 5;

export function defaultMonotonicClock(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export function computeClockSyncSample(
  response: SyncResponsePayload,
  t4: number,
): ClockSyncSample {
  const rttMs = (t4 - response.t1) - (response.t3 - response.t2);
  const offsetMs = ((response.t2 - response.t1) + (response.t3 - t4)) / 2;
  return {
    syncSeq: response.syncSeq,
    t1: response.t1,
    t2: response.t2,
    t3: response.t3,
    t4,
    rttMs,
    offsetMs,
    errorBoundMs: Math.max(0, rttMs / 2),
  };
}

export function computeOneWayDelaySample(options: {
  sentAt: number;
  receivedAt: number;
  errorBoundMs?: number;
  label?: string;
}): OneWayDelaySample {
  const rawDelayMs = options.receivedAt - options.sentAt;
  return {
    sentAt: options.sentAt,
    receivedAt: options.receivedAt,
    rawDelayMs,
    delayMs: Math.max(0, rawDelayMs),
    errorBoundMs: options.errorBoundMs,
    label: options.label,
  };
}

export class ClockSyncHost {
  private readonly unsubscribe: Unsubscribe;
  private readonly now: MonotonicClock;

  constructor(private readonly options: ClockSyncHostOptions) {
    this.now = options.now ?? defaultMonotonicClock;
    this.unsubscribe = options.transport.onMessage((message) => {
      if (message.channel !== "sync") return;
      this.handleMessage(message.fromPeerId, message.data);
    });
  }

  close(): void {
    this.unsubscribe();
  }

  private handleMessage(fromPeerId: PeerId, data: unknown): void {
    const t2 = this.now();
    if (!isProtocolEnvelope(data) || data.roomId !== this.options.roomId) return;
    if (data.type !== "sync_req") return;

    const payload = data.payload as Partial<SyncRequestPayload>;
    if (!isFiniteNumber(payload.syncSeq) || !isFiniteNumber(payload.t1)) return;

    const t3 = this.now();
    this.options.transport.send(
      fromPeerId,
      "sync",
      createEnvelope({
        type: "sync_resp",
        roomId: this.options.roomId,
        senderPeerId: this.options.transport.localPeerId,
        payload: {
          syncSeq: payload.syncSeq,
          t1: payload.t1,
          t2,
          t3,
        } satisfies SyncResponsePayload,
      }),
    );
  }
}

export class ClockSyncClient {
  private readonly unsubscribe: Unsubscribe;
  private readonly nowSource: MonotonicClock;
  private readonly pendingT1BySeq = new Map<number, number>();
  private readonly samples: ClockSyncSample[] = [];
  private readonly bestSampleRatio: number;
  private readonly maxSamples: number;
  private readonly offsetMadFactor: number;
  private nextSeq = 0;
  private estimate: ClockSyncEstimate = {
    locked: false,
    sampleCount: 0,
    selectedSampleCount: 0,
    offsetMs: 0,
    rttMs: Number.POSITIVE_INFINITY,
    bestRttMs: Number.POSITIVE_INFINITY,
    drift: 1,
    interceptMs: 0,
    updatedAt: 0,
  };

  constructor(private readonly options: ClockSyncClientOptions) {
    this.nowSource = options.now ?? defaultMonotonicClock;
    this.bestSampleRatio = clampRatio(options.bestSampleRatio ?? DEFAULT_BEST_SAMPLE_RATIO);
    this.maxSamples = Math.max(1, Math.floor(options.maxSamples ?? DEFAULT_MAX_SAMPLES));
    this.offsetMadFactor = normalizeOffsetMadFactor(options.offsetMadFactor);
    this.unsubscribe = options.transport.onMessage((message) => {
      if (message.channel !== "sync") return;
      this.handleMessage(message.data);
    });
  }

  requestSample(): number {
    this.nextSeq += 1;
    const syncSeq = this.nextSeq;
    const t1 = this.nowSource();
    this.pendingT1BySeq.set(syncSeq, t1);
    this.options.transport.send(
      this.options.hostPeerId,
      "sync",
      createEnvelope({
        type: "sync_req",
        roomId: this.options.roomId,
        senderPeerId: this.options.transport.localPeerId,
        payload: {
          syncSeq,
          t1,
        } satisfies SyncRequestPayload,
      }),
    );
    return syncSeq;
  }

  requestBurst(count: number): number[] {
    const safeCount = Math.max(0, Math.floor(count));
    return Array.from({ length: safeCount }, () => this.requestSample());
  }

  requestBurstScheduled(count: number, spacingMs = 25): ScheduledSyncBurst {
    const safeCount = Math.max(0, Math.floor(count));
    const safeSpacingMs = Math.max(0, spacingMs);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let cancelled = false;

    for (let index = 0; index < safeCount; index += 1) {
      const timer = setTimeout(() => {
        if (!cancelled) this.requestSample();
      }, index * safeSpacingMs);
      timers.push(timer);
    }

    return {
      cancel: () => {
        cancelled = true;
        for (const timer of timers) {
          clearTimeout(timer);
        }
      },
    };
  }

  now(): number {
    return this.hostTimeFromLocal(this.nowSource());
  }

  hostTimeFromLocal(localTime: number): number {
    if (!this.estimate.locked) return localTime;
    return this.estimate.drift * localTime + this.estimate.interceptMs;
  }

  localTimeFromHost(hostTime: number): number {
    if (!this.estimate.locked) return hostTime;
    return (hostTime - this.estimate.interceptMs) / this.estimate.drift;
  }

  scheduleAtHostTime(hostTime: number, callback: () => void): ScheduledHostEvent {
    const localTarget = this.localTimeFromHost(hostTime);
    const delayMs = Math.max(0, localTarget - this.nowSource());
    const timeout = setTimeout(callback, delayMs);
    return {
      cancel: () => clearTimeout(timeout),
    };
  }

  getEstimate(): ClockSyncEstimate {
    return { ...this.estimate };
  }

  getSamples(): readonly ClockSyncSample[] {
    return [...this.samples];
  }

  close(): void {
    this.unsubscribe();
    this.pendingT1BySeq.clear();
  }

  private handleMessage(data: unknown): void {
    if (!isProtocolEnvelope(data) || data.roomId !== this.options.roomId) return;
    if (data.type !== "sync_resp" || data.senderPeerId !== this.options.hostPeerId) return;

    const payload = data.payload as Partial<SyncResponsePayload>;
    if (!isSyncResponsePayload(payload)) return;

    const pendingT1 = this.pendingT1BySeq.get(payload.syncSeq);
    if (pendingT1 === undefined || pendingT1 !== payload.t1) return;
    this.pendingT1BySeq.delete(payload.syncSeq);

    const sample = computeClockSyncSample(payload, this.nowSource());
    if (!Number.isFinite(sample.rttMs) || sample.rttMs < 0) return;

    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
    this.updateEstimate();
  }

  private updateEstimate(): void {
    const rttSelected = selectBestSamples(this.samples, this.bestSampleRatio);
    const selected = filterOffsetOutliersByMad(rttSelected, this.offsetMadFactor);
    if (selected.length === 0) return;

    const offsetMs = median(selected.map((sample) => sample.offsetMs));
    const rttMs = median(selected.map((sample) => sample.rttMs));
    const bestRttMs = rttSelected[0]?.rttMs ?? selected[0].rttMs;
    const regression = estimateLinearClock(selected);

    this.estimate = {
      locked: true,
      sampleCount: this.samples.length,
      selectedSampleCount: selected.length,
      offsetMs,
      rttMs,
      bestRttMs,
      drift: regression.drift,
      interceptMs: regression.intercept,
      updatedAt: Math.max(...selected.map((sample) => sample.t4)),
    };
  }
}

export function selectBestSamples(
  samples: readonly ClockSyncSample[],
  bestSampleRatio = DEFAULT_BEST_SAMPLE_RATIO,
): ClockSyncSample[] {
  if (samples.length === 0) return [];
  const sorted = [...samples].sort((a, b) => a.rttMs - b.rttMs);
  const keep = Math.max(1, Math.ceil(sorted.length * clampRatio(bestSampleRatio)));
  return sorted.slice(0, keep);
}

export function filterOffsetOutliersByMad(
  samples: readonly ClockSyncSample[],
  madFactor = DEFAULT_OFFSET_MAD_FACTOR,
): ClockSyncSample[] {
  if (samples.length <= 2 || !Number.isFinite(madFactor) || madFactor <= 0) {
    return [...samples];
  }

  const offsets = samples.map((sample) => sample.offsetMs);
  const center = median(offsets);
  const deviations = offsets.map((offset) => Math.abs(offset - center));
  const mad = median(deviations);
  const threshold = Math.max(
    Number.isFinite(mad) ? madFactor * mad : 0,
    DEFAULT_OFFSET_OUTLIER_FLOOR_MS,
  );
  const filtered = samples.filter((sample) => Math.abs(sample.offsetMs - center) <= threshold);
  return filtered.length > 0 ? filtered : [...samples];
}

export class OneWayDelayTracker {
  private readonly samples: OneWayDelaySample[] = [];
  private readonly maxSamples: number;

  constructor(options: { maxSamples?: number } = {}) {
    this.maxSamples = Math.max(1, Math.floor(options.maxSamples ?? DEFAULT_ONE_WAY_MAX_SAMPLES));
  }

  addSample(sample: OneWayDelaySample): OneWayDelayEstimate {
    if (!Number.isFinite(sample.sentAt) || !Number.isFinite(sample.receivedAt) || !Number.isFinite(sample.delayMs)) {
      return this.getEstimate();
    }
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
    return this.getEstimate();
  }

  add(sentAt: number, receivedAt: number, options: { errorBoundMs?: number; label?: string } = {}): OneWayDelayEstimate {
    return this.addSample(computeOneWayDelaySample({ sentAt, receivedAt, ...options }));
  }

  getSamples(): readonly OneWayDelaySample[] {
    return [...this.samples];
  }

  getEstimate(): OneWayDelayEstimate {
    if (this.samples.length === 0) {
      return {
        locked: false,
        sampleCount: 0,
        delayMs: Number.POSITIVE_INFINITY,
        bestDelayMs: Number.POSITIVE_INFINITY,
        worstDelayMs: Number.POSITIVE_INFINITY,
        jitterMs: Number.POSITIVE_INFINITY,
        updatedAt: 0,
      };
    }

    const delays = this.samples.map((sample) => sample.delayMs);
    const delayMs = median(delays);
    const deviations = delays.map((delay) => Math.abs(delay - delayMs));
    return {
      locked: true,
      sampleCount: this.samples.length,
      delayMs,
      bestDelayMs: Math.min(...delays),
      worstDelayMs: Math.max(...delays),
      jitterMs: median(deviations),
      updatedAt: this.samples[this.samples.length - 1].receivedAt,
    };
  }

  reset(): void {
    this.samples.length = 0;
  }
}

export class AdaptiveLookaheadController {
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly safetyMarginMs: number;
  private readonly jitterMultiplier: number;
  private readonly riseLimitMs: number;
  private readonly fallLimitMs: number;
  private readonly fallHoldSamples: number;
  private lookaheadMs: number;
  private stableSamples = 0;

  constructor(options: AdaptiveLookaheadOptions = {}) {
    this.minMs = Math.max(0, options.minMs ?? DEFAULT_LOOKAHEAD_MIN_MS);
    this.maxMs = Math.max(this.minMs, options.maxMs ?? DEFAULT_LOOKAHEAD_MAX_MS);
    this.safetyMarginMs = Math.max(0, options.safetyMarginMs ?? DEFAULT_LOOKAHEAD_SAFETY_MARGIN_MS);
    this.jitterMultiplier = Math.max(0, options.jitterMultiplier ?? DEFAULT_LOOKAHEAD_JITTER_MULTIPLIER);
    this.riseLimitMs = Math.max(0, options.riseLimitMs ?? DEFAULT_LOOKAHEAD_RISE_LIMIT_MS);
    this.fallLimitMs = Math.max(0, options.fallLimitMs ?? DEFAULT_LOOKAHEAD_FALL_LIMIT_MS);
    this.fallHoldSamples = Math.max(1, Math.floor(options.fallHoldSamples ?? DEFAULT_LOOKAHEAD_FALL_HOLD_SAMPLES));
    this.lookaheadMs = clampNumber(options.initialMs ?? this.minMs, this.minMs, this.maxMs);
  }

  update(input: AdaptiveLookaheadInput): AdaptiveLookaheadEstimate {
    const targetMs = this.computeTarget(input);
    const clampedTargetMs = clampNumber(targetMs, this.minMs, this.maxMs);
    const isClamped = clampedTargetMs !== targetMs;

    if (clampedTargetMs > this.lookaheadMs) {
      this.stableSamples = 0;
      this.lookaheadMs = Math.min(clampedTargetMs, this.lookaheadMs + this.riseLimitMs);
    } else if (clampedTargetMs < this.lookaheadMs) {
      this.stableSamples += 1;
      if (this.stableSamples >= this.fallHoldSamples) {
        this.lookaheadMs = Math.max(clampedTargetMs, this.lookaheadMs - this.fallLimitMs);
      }
    } else {
      this.stableSamples += 1;
    }

    this.lookaheadMs = clampNumber(this.lookaheadMs, this.minMs, this.maxMs);
    return this.getEstimate(clampedTargetMs, isClamped);
  }

  getEstimate(targetMs = this.lookaheadMs, clamped = false): AdaptiveLookaheadEstimate {
    return {
      lookaheadMs: this.lookaheadMs,
      targetMs,
      clamped,
      stableSamples: this.stableSamples,
    };
  }

  reset(valueMs = this.minMs): AdaptiveLookaheadEstimate {
    this.lookaheadMs = clampNumber(valueMs, this.minMs, this.maxMs);
    this.stableSamples = 0;
    return this.getEstimate();
  }

  private computeTarget(input: AdaptiveLookaheadInput): number {
    const oneWayDelayMs = finiteOrZero(input.oneWayDelayMs);
    const jitterMs = finiteOrZero(input.oneWayJitterMs);
    const clockErrorBoundMs = finiteOrZero(input.clockErrorBoundMs);
    const rttFallbackMs = finiteOrZero(input.rttMs) / 2;
    const baseDelayMs = Math.max(oneWayDelayMs, rttFallbackMs);
    return baseDelayMs + this.jitterMultiplier * jitterMs + clockErrorBoundMs + this.safetyMarginMs;
  }
}

function estimateLinearClock(samples: readonly ClockSyncSample[]): { drift: number; intercept: number } {
  if (samples.length < 2) {
    const sample = samples[0];
    return { drift: 1, intercept: sample ? sample.offsetMs : 0 };
  }

  const points = samples.map((sample) => ({
    x: sample.t4,
    y: sample.t4 + sample.offsetMs,
  }));
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const varianceX = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  if (varianceX === 0) {
    return { drift: 1, intercept: median(samples.map((sample) => sample.offsetMs)) };
  }

  const covariance = points.reduce(
    (sum, point) => sum + (point.x - meanX) * (point.y - meanY),
    0,
  );
  const drift = covariance / varianceX;
  const intercept = meanY - drift * meanX;
  return { drift, intercept };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BEST_SAMPLE_RATIO;
  return Math.min(1, Math.max(0.01, value));
}

function normalizeOffsetMadFactor(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_OFFSET_MAD_FACTOR;
  return Math.max(0, value);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function finiteOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSyncResponsePayload(value: Partial<SyncResponsePayload>): value is SyncResponsePayload {
  return (
    isFiniteNumber(value.syncSeq) &&
    isFiniteNumber(value.t1) &&
    isFiniteNumber(value.t2) &&
    isFiniteNumber(value.t3)
  );
}
