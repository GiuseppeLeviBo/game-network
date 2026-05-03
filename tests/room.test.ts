import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeNetwork, GuestRoom, HostRoom } from "../src/index.js";

describe("host and guest rooms", () => {
  it("lets a guest join a host room and receive an assigned player id", () => {
    const network = new FakeNetwork();
    const host = new HostRoom({
      roomId: "ROOM-1",
      maxPlayers: 3,
      displayName: "Host",
      transport: network.createPeer("host-peer"),
      assignPlayerId: (index) => `p${index + 1}`,
    });
    const guest = new GuestRoom({
      roomId: "ROOM-1",
      displayName: "ABC",
      hostPeerId: "host-peer",
      transport: network.createPeer("guest-peer"),
    });
    let joinedName = "";

    host.onPlayerJoined((player) => {
      joinedName = player.displayName;
    });

    guest.join();

    assert.equal(joinedName, "ABC");
    assert.equal(guest.localPlayer?.id, "p2");
    assert.deepEqual(
      host.players.map((player) => player.id),
      ["p1", "p2"],
    );
  });

  it("rejects guests after the game-configured room limit is reached", () => {
    const network = new FakeNetwork();
    new HostRoom({
      roomId: "ROOM-1",
      maxPlayers: 1,
      displayName: "Host",
      transport: network.createPeer("host-peer"),
    });
    const guest = new GuestRoom({
      roomId: "ROOM-1",
      displayName: "ABC",
      hostPeerId: "host-peer",
      transport: network.createPeer("guest-peer"),
    });
    let rejectReason = "";

    guest.onRejected((payload) => {
      rejectReason = payload.reason;
    });

    guest.join();

    assert.equal(rejectReason, "room_full");
    assert.equal(guest.localPlayer, undefined);
  });

  it("routes guest input to the host and host snapshots back to guests", () => {
    type Input = { direction: "left" | "right" };
    type Snapshot = { tick: number; x: number };

    const network = new FakeNetwork();
    const host = new HostRoom<Input, Snapshot>({
      roomId: "ROOM-1",
      maxPlayers: 2,
      displayName: "Host",
      transport: network.createPeer("host-peer"),
    });
    const guest = new GuestRoom<Input, Snapshot>({
      roomId: "ROOM-1",
      displayName: "ABC",
      hostPeerId: "host-peer",
      transport: network.createPeer("guest-peer"),
    });
    const inputs: Input[] = [];
    const snapshots: Snapshot[] = [];

    host.onInput((payload) => {
      inputs.push(payload.input);
      host.sendSnapshot({ tick: payload.clientSeq, x: 12 });
    });
    guest.onSnapshot((payload) => {
      snapshots.push(payload.snapshot);
    });

    guest.join();
    guest.sendInput({ direction: "left" });

    assert.deepEqual(inputs, [{ direction: "left" }]);
    assert.deepEqual(snapshots, [{ tick: 1, x: 12 }]);
  });
});
