# Cloudflare Quality Probe

This probe uses Playwright to open two chess PWA instances against the public
Cloudflare Worker WebSocket relay and measure transport quality over time.

It is a measurement probe, not a chess gameplay test. It fails only if the two
pages cannot connect or cannot produce telemetry. A noisy Cloudflare run is
reported as `PLAYABLE` or `UNSTABLE` in the generated summary, but it is still a
valid measurement.

## Default command

```bash
npm run probe:cloudflare
```

Defaults:

- duration: 5 minutes;
- warm-up discarded from analysis: 60 seconds;
- game URL: `https://giuseppelevibo.github.io/game-network/single-file-chess-game/index.html`;
- signaling URL: `wss://game-network.giuseppe-levi.workers.dev/ws`;
- output directory: `Notes/cloudflare-probe/<timestamp-room>/`.

Each run writes:

- host CSV;
- guest CSV;
- host JSON telemetry;
- guest JSON telemetry;
- `summary.json`;
- `summary.md`;
- browser console log, if any messages were captured.

## Useful environment variables

```bash
GAME_NETWORK_PROBE_DURATION_MS=300000
GAME_NETWORK_PROBE_WARMUP_MS=60000
GAME_NETWORK_PROBE_OUTPUT_DIR=Notes/cloudflare-probe
GAME_NETWORK_PROBE_URL=https://giuseppelevibo.github.io/game-network/single-file-chess-game/index.html
GAME_NETWORK_SIGNALING_URL=wss://game-network.giuseppe-levi.workers.dev/ws
GAME_NETWORK_PROBE_ROOM=CF-MANUAL-001
```

## Linux setup

Install dependencies once:

```bash
npm ci
npx playwright install chromium
```

On minimal servers, Playwright may also need Linux browser dependencies. If the
first run reports missing shared libraries, run the Playwright dependency
installer for the target distribution or install Chromium dependencies through
the system package manager.

## Cron

Yes, the probe can be started from cron. Use absolute paths because cron has a
minimal environment.

Example, every 6 hours:

```cron
0 */6 * * * cd /path/to/game-network && /usr/bin/npm run probe:cloudflare >> /path/to/game-network/Notes/cloudflare-probe/cron.log 2>&1
```

For a custom duration:

```cron
0 */6 * * * cd /path/to/game-network && GAME_NETWORK_PROBE_DURATION_MS=300000 /usr/bin/npm run probe:cloudflare >> /path/to/game-network/Notes/cloudflare-probe/cron.log 2>&1
```

Recommended practice:

- run under the same Linux user that installed Playwright browsers;
- avoid overlapping jobs;
- keep the machine awake and network-stable during the 5-minute run;
- collect several runs at different hours before drawing conclusions.

## Metrics

The summary separates:

- clock offset estimate and offset spread;
- WebSocket event delivery quality;
- late probe rate;
- worst late probe;
- telemetry batch delay.
- 30-second windows, so warm-up phases and isolated spikes are visible.
- worst late-probe details, including scheduling, send, and receive timing.
- direction summaries for `host-to-guest` and `guest-to-host` probes.

This distinction matters: a run can have excellent clock synchronization and
still show occasional late events when the Cloudflare/WebSocket path has a queue
or routing spike.

The report also includes a nearest-sample timeline comparison. That value is
limited by the telemetry sampling cadence and must not be read as the primary
clock-error metric.

The `clock offset estimate` is the clock model's estimated offset between the
two local monotonic clocks. Its absolute value is not an error. The `offset
spread` is usually more useful for checking whether the model is stable during a
run.

The late-probe detail table is intended to distinguish a transport spike from a
local scheduling delay. `Send lead` is the planned lead time between send and
scheduled execution, `Sent to received` is the measured event delivery time, and
`Received after schedule` is the amount by which a late event missed its target.
