import type { PeerId, Unsubscribe } from "./protocol.js";

export type TransportChannelName = "control" | "realtime";

export interface TransportMessage {
  channel: TransportChannelName;
  fromPeerId: PeerId;
  toPeerId?: PeerId;
  data: unknown;
}

export interface GameNetworkTransport {
  readonly localPeerId: PeerId;

  send(toPeerId: PeerId, channel: TransportChannelName, data: unknown): void;
  broadcast(channel: TransportChannelName, data: unknown): void;
  close(): void;

  onMessage(handler: (message: TransportMessage) => void): Unsubscribe;
  onClose(handler: () => void): Unsubscribe;
}

