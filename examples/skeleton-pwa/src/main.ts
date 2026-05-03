import "./style.css";
import { GuestRoom, HostRoom, type PlayerInfo } from "../../../src/index";
import { BroadcastChannelTransport } from "./broadcastTransport";

type SkeletonInput = {
  action: "pulse";
  value: number;
};

type SkeletonSnapshot = {
  tick: number;
  lastPlayerId: string;
  totalInputs: number;
};

const params = new URLSearchParams(window.location.search);
const role = params.get("role") === "guest" ? "guest" : "host";
const roomId = params.get("room") || "ROOM-1";
const displayName = params.get("name") || (role === "host" ? "HST" : "GST");
const peerId = params.get("peer") || `${role}-${Math.random().toString(36).slice(2, 8)}`;
const hostPeerId = params.get("host") || "host-peer";

const roleEl = byTestId("role");
const roomEl = byTestId("room");
const statusEl = byTestId("status");
const localPlayerEl = byTestId("local-player");
const playersEl = byTestId("players");
const lastInputEl = byTestId("last-input");
const lastSnapshotEl = byTestId("last-snapshot");
const sendInputButton = byTestId("send-input") as HTMLButtonElement;

roleEl.textContent = role;
roomEl.textContent = roomId;
sendInputButton.disabled = true;

let totalInputs = 0;

const transport = new BroadcastChannelTransport(peerId, roomId);

if (role === "host") {
  const room = new HostRoom<SkeletonInput, SkeletonSnapshot>({
    roomId,
    maxPlayers: Number(params.get("maxPlayers") || 8),
    displayName,
    transport,
    assignPlayerId: (index) => `p${index + 1}`,
  });

  statusEl.textContent = "Hosting";
  localPlayerEl.textContent = `${room.localPlayer.id} ${room.localPlayer.displayName}`;
  renderPlayers(room.players);
  sendInputButton.disabled = true;

  room.onPlayerJoined(() => {
    renderPlayers(room.players);
  });

  room.onInput((payload) => {
    totalInputs += 1;
    lastInputEl.textContent = `${payload.playerId}:${payload.input.action}:${payload.input.value}`;
    room.sendSnapshot({
      tick: payload.clientSeq,
      lastPlayerId: payload.playerId,
      totalInputs,
    });
  });
} else {
  const room = new GuestRoom<SkeletonInput, SkeletonSnapshot>({
    roomId,
    displayName,
    hostPeerId,
    transport,
  });

  statusEl.textContent = "Joining";

  room.onConnected((payload) => {
    statusEl.textContent = "Connected";
    localPlayerEl.textContent = `${payload.localPlayer.id} ${payload.localPlayer.displayName}`;
    renderPlayers(payload.room.players);
    sendInputButton.disabled = false;
  });

  room.onRejected((payload) => {
    statusEl.textContent = `Rejected: ${payload.reason}`;
  });

  room.onPlayersChanged((players) => {
    renderPlayers(players);
  });

  room.onSnapshot((payload) => {
    lastSnapshotEl.textContent = `${payload.snapshot.lastPlayerId}:${payload.snapshot.totalInputs}`;
  });

  sendInputButton.addEventListener("click", () => {
    room.sendInput({ action: "pulse", value: Date.now() });
  });

  setTimeout(() => room.join(), 50);
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // PWA registration is useful for the example, but networking tests do not depend on it.
  });
}

function renderPlayers(players: readonly PlayerInfo[]): void {
  playersEl.replaceChildren(
    ...players.map((player) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      const id = document.createElement("strong");
      name.textContent = player.displayName;
      id.textContent = player.id;
      item.append(name, id);
      return item;
    }),
  );
}

function byTestId(id: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${id}"]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing element: ${id}`);
  }
  return element;
}
