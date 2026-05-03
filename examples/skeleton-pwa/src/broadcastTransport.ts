import type {
  GameNetworkTransport,
  TransportChannelName,
  TransportMessage,
} from "../../../src/index";
import { EventSlot, type PeerId, type Unsubscribe } from "../../../src/index";

interface BroadcastPayload {
  channel: TransportChannelName;
  fromPeerId: PeerId;
  toPeerId?: PeerId;
  data: unknown;
}

export class BroadcastChannelTransport implements GameNetworkTransport {
  private readonly channel: BroadcastChannel;
  private readonly messageSlot = new EventSlot<[TransportMessage]>();
  private readonly closeSlot = new EventSlot<[]>();

  constructor(
    readonly localPeerId: PeerId,
    roomId: string,
  ) {
    this.channel = new BroadcastChannel(`game-network:${roomId}`);
    this.channel.addEventListener("message", (event: MessageEvent<BroadcastPayload>) => {
      const payload = event.data;
      if (!payload || payload.fromPeerId === this.localPeerId) return;
      if (payload.toPeerId && payload.toPeerId !== this.localPeerId) return;
      this.messageSlot.emit(payload);
    });
  }

  send(toPeerId: PeerId, channel: TransportChannelName, data: unknown): void {
    this.channel.postMessage({
      channel,
      fromPeerId: this.localPeerId,
      toPeerId,
      data,
    } satisfies BroadcastPayload);
  }

  broadcast(channel: TransportChannelName, data: unknown): void {
    this.channel.postMessage({
      channel,
      fromPeerId: this.localPeerId,
      data,
    } satisfies BroadcastPayload);
  }

  close(): void {
    this.channel.close();
    this.closeSlot.emit();
  }

  onMessage(handler: (message: TransportMessage) => void): Unsubscribe {
    return this.messageSlot.subscribe(handler);
  }

  onClose(handler: () => void): Unsubscribe {
    return this.closeSlot.subscribe(handler);
  }
}
