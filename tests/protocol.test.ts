import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, createEnvelope, isProtocolEnvelope } from "../src/index.js";

describe("protocol envelopes", () => {
  it("creates versioned messages with room and sender information", () => {
    const message = createEnvelope({
      type: "ping",
      roomId: "ROOM-1",
      senderPeerId: "peer-a",
      payload: { nonce: "abc" },
      seq: 7,
    });

    assert.equal(message.version, PROTOCOL_VERSION);
    assert.equal(message.type, "ping");
    assert.equal(message.roomId, "ROOM-1");
    assert.equal(message.senderPeerId, "peer-a");
    assert.deepEqual(message.payload, { nonce: "abc" });
    assert.equal(isProtocolEnvelope(message), true);
  });

  it("rejects objects that do not match the protocol envelope shape", () => {
    assert.equal(isProtocolEnvelope({ type: "ping" }), false);
    assert.equal(isProtocolEnvelope(null), false);
    assert.equal(isProtocolEnvelope("ping"), false);
  });
});
