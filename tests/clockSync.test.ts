import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AdaptiveLookaheadController,
  ClockSyncClient,
  ClockSyncHost,
  FakeNetwork,
  OneWayDelayTracker,
  computeClockSyncSample,
  computeOneWayDelaySample,
  filterOffsetOutliersByMad,
  selectBestSamples,
  type MonotonicClock,
} from "../src/index.js";

function scriptedClock(values: number[]): MonotonicClock {
  let last = values[0] ?? 0;
  return () => {
    last = values.shift() ?? last;
    return last;
  };
}

describe("clock sync", () => {
  it("computes NTP-style offset and round-trip delay from four timestamps", () => {
    const sample = computeClockSyncSample(
      {
        syncSeq: 1,
        t1: 1000,
        t2: 1058,
        t3: 1059,
      },
      1020,
    );

    assert.equal(sample.rttMs, 19);
    assert.equal(sample.offsetMs, 48.5);
    assert.equal(sample.errorBoundMs, 9.5);
  });

  it("keeps the lowest-RTT samples for robust estimation", () => {
    const samples = [
      { syncSeq: 1, t1: 0, t2: 0, t3: 0, t4: 0, rttMs: 42, offsetMs: 80, errorBoundMs: 21 },
      { syncSeq: 2, t1: 0, t2: 0, t3: 0, t4: 0, rttMs: 10, offsetMs: 51, errorBoundMs: 5 },
      { syncSeq: 3, t1: 0, t2: 0, t3: 0, t4: 0, rttMs: 12, offsetMs: 49, errorBoundMs: 6 },
      { syncSeq: 4, t1: 0, t2: 0, t3: 0, t4: 0, rttMs: 80, offsetMs: -20, errorBoundMs: 40 },
    ];

    assert.deepEqual(
      selectBestSamples(samples, 0.5).map((sample) => sample.syncSeq),
      [2, 3],
    );
  });

  it("exchanges sync messages over the sync channel and estimates host time", () => {
    const network = new FakeNetwork();
    const hostTransport = network.createPeer("host-peer");
    const guestTransport = network.createPeer("guest-peer");
    const hostClock = scriptedClock([1058, 1059, 2059, 2060]);
    const guestClock = scriptedClock([1000, 1020, 2000, 2020, 3000]);
    const host = new ClockSyncHost({
      roomId: "ROOM-1",
      transport: hostTransport,
      now: hostClock,
    });
    const client = new ClockSyncClient({
      roomId: "ROOM-1",
      hostPeerId: "host-peer",
      transport: guestTransport,
      now: guestClock,
      bestSampleRatio: 1,
    });

    client.requestBurst(2);

    const estimate = client.getEstimate();
    assert.equal(estimate.locked, true);
    assert.equal(estimate.sampleCount, 2);
    assert.equal(estimate.selectedSampleCount, 2);
    assert.equal(estimate.rttMs, 19);
    assert.equal(estimate.offsetMs, 49);
    assert.ok(Number.isFinite(estimate.interceptMs));
    assert.ok(Math.abs(client.now() - 3050.5) < 0.05);

    host.close();
    client.close();
  });

  it("filters offset outliers after selecting low-RTT samples", () => {
    const samples = [
      { syncSeq: 1, t1: 0, t2: 0, t3: 0, t4: 0, rttMs: 10, offsetMs: 50, errorBoundMs: 5 },
      { syncSeq: 2, t1: 0, t2: 0, t3: 0, t4: 0, rttMs: 11, offsetMs: 51, errorBoundMs: 5.5 },
      { syncSeq: 3, t1: 0, t2: 0, t3: 0, t4: 0, rttMs: 12, offsetMs: 49, errorBoundMs: 6 },
      { syncSeq: 4, t1: 0, t2: 0, t3: 0, t4: 0, rttMs: 13, offsetMs: 150, errorBoundMs: 6.5 },
    ];

    assert.deepEqual(
      filterOffsetOutliersByMad(samples, 3).map((sample) => sample.syncSeq),
      [1, 2, 3],
    );
  });

  it("filters offset outliers when the median absolute deviation is zero", () => {
    const samples = [
      { syncSeq: 1, t1: 0, t2: 0, t3: 0, t4: 0, rttMs: 10, offsetMs: 50, errorBoundMs: 5 },
      { syncSeq: 2, t1: 0, t2: 0, t3: 0, t4: 0, rttMs: 11, offsetMs: 50, errorBoundMs: 5.5 },
      { syncSeq: 3, t1: 0, t2: 0, t3: 0, t4: 0, rttMs: 12, offsetMs: 50, errorBoundMs: 6 },
      { syncSeq: 4, t1: 0, t2: 0, t3: 0, t4: 0, rttMs: 13, offsetMs: 150, errorBoundMs: 6.5 },
    ];

    assert.deepEqual(
      filterOffsetOutliersByMad(samples, 3).map((sample) => sample.syncSeq),
      [1, 2, 3],
    );
  });

  it("schedules burst samples over time and can cancel pending samples", async () => {
    const network = new FakeNetwork();
    const hostTransport = network.createPeer("host-peer");
    const guestTransport = network.createPeer("guest-peer");
    const host = new ClockSyncHost({
      roomId: "ROOM-1",
      transport: hostTransport,
      now: () => performance.now(),
    });
    const client = new ClockSyncClient({
      roomId: "ROOM-1",
      hostPeerId: "host-peer",
      transport: guestTransport,
      now: () => performance.now(),
      bestSampleRatio: 1,
    });

    client.requestBurstScheduled(3, 20);
    await new Promise((resolve) => setTimeout(resolve, 90));

    const samples = client.getSamples();
    assert.equal(samples.length, 3);
    assert.ok(samples[1].t1 - samples[0].t1 >= 10);
    assert.ok(samples[2].t1 - samples[1].t1 >= 10);

    const cancelled = client.requestBurstScheduled(3, 20);
    cancelled.cancel();
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(client.getSamples().length, 3);

    host.close();
    client.close();
  });

  it("computes assisted one-way delay and tracks jitter", () => {
    const sample = computeOneWayDelaySample({
      sentAt: 1000,
      receivedAt: 1016,
      errorBoundMs: 5,
      label: "snapshot",
    });

    assert.equal(sample.rawDelayMs, 16);
    assert.equal(sample.delayMs, 16);
    assert.equal(sample.errorBoundMs, 5);
    assert.equal(sample.label, "snapshot");

    const tracker = new OneWayDelayTracker({ maxSamples: 3 });
    tracker.add(1000, 1016);
    tracker.add(2000, 2018);
    const estimate = tracker.add(3000, 3014);

    assert.equal(estimate.locked, true);
    assert.equal(estimate.sampleCount, 3);
    assert.equal(estimate.delayMs, 16);
    assert.equal(estimate.bestDelayMs, 14);
    assert.equal(estimate.worstDelayMs, 18);
    assert.equal(estimate.jitterMs, 2);
  });

  it("adapts lookahead with hysteresis and bounded step changes", () => {
    const controller = new AdaptiveLookaheadController({
      minMs: 25,
      maxMs: 80,
      safetyMarginMs: 5,
      jitterMultiplier: 2,
      riseLimitMs: 10,
      fallLimitMs: 2,
      fallHoldSamples: 3,
      initialMs: 25,
    });

    const first = controller.update({
      oneWayDelayMs: 20,
      oneWayJitterMs: 10,
      clockErrorBoundMs: 5,
    });
    assert.equal(first.targetMs, 50);
    assert.equal(first.lookaheadMs, 35);

    const second = controller.update({
      oneWayDelayMs: 100,
      oneWayJitterMs: 20,
      clockErrorBoundMs: 20,
    });
    assert.equal(second.targetMs, 80);
    assert.equal(second.clamped, true);
    assert.equal(second.lookaheadMs, 45);

    for (let index = 0; index < 2; index += 1) {
      controller.update({ oneWayDelayMs: 1, oneWayJitterMs: 0 });
    }
    assert.equal(controller.getEstimate().lookaheadMs, 45);

    const falling = controller.update({ oneWayDelayMs: 1, oneWayJitterMs: 0 });
    assert.equal(falling.targetMs, 25);
    assert.equal(falling.lookaheadMs, 43);
  });
});
