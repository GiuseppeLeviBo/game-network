import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeNetwork } from "../src/index.js";

describe("fake transport", () => {
  it("delivers direct messages to the selected peer", () => {
    const network = new FakeNetwork();
    const host = network.createPeer("host");
    const guest = network.createPeer("guest");
    const received: unknown[] = [];

    guest.onMessage((message) => {
      received.push(message.data);
    });

    host.send("guest", "control", { hello: "world" });

    assert.deepEqual(received, [{ hello: "world" }]);
  });

  it("broadcasts to every peer except the sender", () => {
    const network = new FakeNetwork();
    const host = network.createPeer("host");
    const guestA = network.createPeer("guest-a");
    const guestB = network.createPeer("guest-b");
    const hostMessages: unknown[] = [];
    const guestMessages: unknown[] = [];

    host.onMessage((message) => hostMessages.push(message.data));
    guestA.onMessage((message) => guestMessages.push(["a", message.data]));
    guestB.onMessage((message) => guestMessages.push(["b", message.data]));

    host.broadcast("realtime", { tick: 1 });

    assert.deepEqual(hostMessages, []);
    assert.deepEqual(guestMessages, [
      ["a", { tick: 1 }],
      ["b", { tick: 1 }],
    ]);
  });
});
