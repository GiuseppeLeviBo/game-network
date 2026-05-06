import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ClockSyncClient,
  ClockSyncHost,
  FakeNetwork,
  computeClockSyncSample,
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
    assert.ok(Math.abs(client.now() - 3050.5) < 0.05);

    host.close();
    client.close();
  });
});
