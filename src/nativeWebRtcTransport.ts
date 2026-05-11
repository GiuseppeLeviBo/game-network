import { EventSlot } from "./events.js";
import type { PeerId, Unsubscribe } from "./protocol.js";
import type {
  GameNetworkTransport,
  TransportChannelName,
  TransportMessage,
} from "./transport.js";
import { isTransportChannelName } from "./transport.js";

export interface NativeWebRtcTransportOptions {
  peerId: PeerId;
  signalingUrl: string;
  rtcConfig?: RTCConfiguration;
}

type SignalPayload =
  | {
      type: "offer";
      description: RTCSessionDescriptionInit;
    }
  | {
      type: "answer";
      description: RTCSessionDescriptionInit;
    }
  | {
      type: "candidate";
      candidate: RTCIceCandidateInit;
    };

type HubClientMessage =
  | {
      kind: "register";
      peerId: PeerId;
    }
  | {
      kind: "signal";
      toPeerId: PeerId;
      payload: SignalPayload;
    };

type HubServerMessage =
  | {
      kind: "registered";
      peerId: PeerId;
    }
  | {
      kind: "signal";
      fromPeerId: PeerId;
      toPeerId: PeerId;
      payload: SignalPayload;
    }
  | {
      kind: "peer_disconnected";
      peerId: PeerId;
    };

interface DataChannelPayload {
  marker: "game-network-native-webrtc";
  channel: TransportChannelName;
  data: unknown;
}

interface PeerState {
  connection: RTCPeerConnection;
  dataChannels: Partial<Record<TransportChannelName, RTCDataChannel>>;
  queueByChannel: Record<TransportChannelName, DataChannelPayload[]>;
  pendingCandidates: RTCIceCandidateInit[];
}

const TRANSPORT_CHANNELS: readonly TransportChannelName[] = ["control", "realtime", "sync"];

const DATA_CHANNEL_OPTIONS: Record<TransportChannelName, RTCDataChannelInit> = {
  control: {
    ordered: true,
  },
  realtime: {
    ordered: false,
    maxRetransmits: 0,
  },
  sync: {
    ordered: false,
    maxRetransmits: 0,
  },
};

export class NativeWebRtcTransport implements GameNetworkTransport {
  private readonly messageSlot = new EventSlot<[TransportMessage]>();
  private readonly closeSlot = new EventSlot<[]>();
  private readonly peerDisconnectedSlot = new EventSlot<[PeerId]>();
  private readonly errorSlot = new EventSlot<[Error]>();
  private readonly peers = new Map<PeerId, PeerState>();
  private readonly signalingSocket: WebSocket;
  private isClosing = false;

  private constructor(
    readonly localPeerId: PeerId,
    signalingSocket: WebSocket,
    private readonly rtcConfig: RTCConfiguration,
  ) {
    this.signalingSocket = signalingSocket;
    signalingSocket.addEventListener("message", (event) => {
      void this.handleSignalingMessage(event.data);
    });
    signalingSocket.addEventListener("close", () => this.closeSlot.emit());
    signalingSocket.addEventListener("error", () =>
      this.errorSlot.emit(new Error("WebRTC signaling socket error")),
    );
  }

  static async create(options: NativeWebRtcTransportOptions): Promise<NativeWebRtcTransport> {
    const socket = new WebSocket(options.signalingUrl);
    await waitForSocketOpen(socket);
    const transport = new NativeWebRtcTransport(
      options.peerId,
      socket,
      options.rtcConfig ?? { iceServers: [] },
    );
    transport.sendSignalRaw({
      kind: "register",
      peerId: options.peerId,
    });
    return transport;
  }

  async connect(peerId: PeerId): Promise<void> {
    const state = this.getOrCreatePeerState(peerId);
    if (areAllDataChannelsOpen(state)) return;

    for (const channel of TRANSPORT_CHANNELS) {
      if (state.dataChannels[channel]) continue;
      const dataChannel = state.connection.createDataChannel(channel, DATA_CHANNEL_OPTIONS[channel]);
      this.registerDataChannel(peerId, state, dataChannel);
    }

    const offer = await state.connection.createOffer();
    await state.connection.setLocalDescription(offer);
    this.sendSignal(peerId, {
      type: "offer",
      description: offer,
    });

    await waitForPeerDataChannelsOpen(state);
  }

  send(toPeerId: PeerId, channel: TransportChannelName, data: unknown): void {
    const state = this.getOrCreatePeerState(toPeerId);
    const payload = createPayload(channel, data);
    const dataChannel = state.dataChannels[channel];
    if (dataChannel?.readyState === "open") {
      dataChannel.send(JSON.stringify(payload));
      return;
    }

    state.queueByChannel[channel].push(payload);
  }

  broadcast(channel: TransportChannelName, data: unknown): void {
    for (const peerId of this.peers.keys()) {
      this.send(peerId, channel, data);
    }
  }

  close(): void {
    this.isClosing = true;
    for (const state of this.peers.values()) {
      for (const dataChannel of Object.values(state.dataChannels)) {
        dataChannel?.close();
      }
      state.connection.close();
    }
    this.peers.clear();
    this.signalingSocket.close();
    this.closeSlot.emit();
  }

  onMessage(handler: (message: TransportMessage) => void): Unsubscribe {
    return this.messageSlot.subscribe(handler);
  }

  onClose(handler: () => void): Unsubscribe {
    return this.closeSlot.subscribe(handler);
  }

  onPeerDisconnected(handler: (peerId: PeerId) => void): Unsubscribe {
    return this.peerDisconnectedSlot.subscribe(handler);
  }

  onError(handler: (error: Error) => void): Unsubscribe {
    return this.errorSlot.subscribe(handler);
  }

  private async handleSignalingMessage(data: unknown): Promise<void> {
    const message = parseHubMessage(data);
    if (!message) return;
    if (message.kind === "peer_disconnected") {
      this.removePeer(message.peerId, false);
      this.peerDisconnectedSlot.emit(message.peerId);
      return;
    }
    if (message.kind !== "signal") return;

    const peerId = message.fromPeerId;
    const state = this.getOrCreatePeerState(peerId);
    const payload = message.payload;

    if (payload.type === "offer") {
      await state.connection.setRemoteDescription(payload.description);
      await this.flushPendingCandidates(state);
      const answer = await state.connection.createAnswer();
      await state.connection.setLocalDescription(answer);
      this.sendSignal(peerId, {
        type: "answer",
        description: answer,
      });
      return;
    }

    if (payload.type === "answer") {
      await state.connection.setRemoteDescription(payload.description);
      await this.flushPendingCandidates(state);
      return;
    }

    if (payload.type === "candidate") {
      if (state.connection.remoteDescription) {
        await state.connection.addIceCandidate(payload.candidate);
      } else {
        state.pendingCandidates.push(payload.candidate);
      }
    }
  }

  private getOrCreatePeerState(peerId: PeerId): PeerState {
    const existingState = this.peers.get(peerId);
    if (existingState) return existingState;

    const connection = new RTCPeerConnection(this.rtcConfig);
    const state: PeerState = {
      connection,
      dataChannels: {},
      queueByChannel: createChannelQueues(),
      pendingCandidates: [],
    };

    connection.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return;
      this.sendSignal(peerId, {
        type: "candidate",
        candidate: event.candidate.toJSON(),
      });
    });
    connection.addEventListener("datachannel", (event) => {
      this.registerDataChannel(peerId, state, event.channel);
    });
    connection.addEventListener("connectionstatechange", () => {
      if (
        connection.connectionState === "failed" ||
        connection.connectionState === "closed" ||
        connection.connectionState === "disconnected"
      ) {
        this.removePeer(peerId, !this.isClosing);
      }
    });

    this.peers.set(peerId, state);
    return state;
  }

  private removePeer(peerId: PeerId, emitDisconnected: boolean): void {
    const state = this.peers.get(peerId);
    if (!state) return;
    for (const dataChannel of Object.values(state.dataChannels)) {
      dataChannel?.close();
    }
    state.connection.close();
    this.peers.delete(peerId);
    if (emitDisconnected) {
      this.peerDisconnectedSlot.emit(peerId);
    }
  }

  private registerDataChannel(
    peerId: PeerId,
    state: PeerState,
    dataChannel: RTCDataChannel,
  ): void {
    const channel = dataChannelLabelToTransportChannel(dataChannel.label);
    if (!channel) {
      dataChannel.close();
      this.errorSlot.emit(new Error(`Unknown DataChannel label from ${peerId}: ${dataChannel.label}`));
      return;
    }

    state.dataChannels[channel] = dataChannel;
    dataChannel.addEventListener("open", () => this.flushDataQueue(state, channel));
    dataChannel.addEventListener("message", (event) => {
      const payload = parseDataChannelPayload(event.data);
      if (!payload) return;
      this.messageSlot.emit({
        channel,
        fromPeerId: peerId,
        toPeerId: this.localPeerId,
        data: payload.data,
      });
    });
    dataChannel.addEventListener("error", () =>
      this.errorSlot.emit(new Error(`DataChannel error from ${peerId}`)),
    );

    if (dataChannel.readyState === "open") {
      this.flushDataQueue(state, channel);
    }
  }

  private flushDataQueue(state: PeerState, channel: TransportChannelName): void {
    const dataChannel = state.dataChannels[channel];
    if (!dataChannel || dataChannel.readyState !== "open") return;
    const queue = [...state.queueByChannel[channel]];
    state.queueByChannel[channel].length = 0;
    for (const payload of queue) {
      dataChannel.send(JSON.stringify(payload));
    }
  }

  private async flushPendingCandidates(state: PeerState): Promise<void> {
    const candidates = [...state.pendingCandidates];
    state.pendingCandidates.length = 0;
    for (const candidate of candidates) {
      await state.connection.addIceCandidate(candidate);
    }
  }

  private sendSignal(toPeerId: PeerId, payload: SignalPayload): void {
    this.sendSignalRaw({
      kind: "signal",
      toPeerId,
      payload,
    });
  }

  private sendSignalRaw(message: HubClientMessage): void {
    this.signalingSocket.send(JSON.stringify(message));
  }
}

function createPayload(channel: TransportChannelName, data: unknown): DataChannelPayload {
  return {
    marker: "game-network-native-webrtc",
    channel,
    data,
  };
}

function createChannelQueues(): Record<TransportChannelName, DataChannelPayload[]> {
  return {
    control: [],
    realtime: [],
    sync: [],
  };
}

function dataChannelLabelToTransportChannel(label: string): TransportChannelName | undefined {
  return isTransportChannelName(label) ? label : undefined;
}

function areAllDataChannelsOpen(state: PeerState): boolean {
  return TRANSPORT_CHANNELS.every((channel) => state.dataChannels[channel]?.readyState === "open");
}

function parseHubMessage(data: unknown): HubServerMessage | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = JSON.parse(data) as Partial<HubServerMessage>;
    if (parsed.kind === "registered" && typeof parsed.peerId === "string") {
      return parsed as HubServerMessage;
    }
    if (parsed.kind === "peer_disconnected" && typeof parsed.peerId === "string") {
      return parsed as HubServerMessage;
    }
    if (
      parsed.kind === "signal" &&
      typeof parsed.fromPeerId === "string" &&
      typeof parsed.toPeerId === "string" &&
      parsed.payload &&
      typeof parsed.payload === "object"
    ) {
      return parsed as HubServerMessage;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseDataChannelPayload(data: unknown): DataChannelPayload | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = JSON.parse(data) as Partial<DataChannelPayload>;
    if (
      parsed.marker === "game-network-native-webrtc" &&
      isTransportChannelName(parsed.channel)
    ) {
      return parsed as DataChannelPayload;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === socket.OPEN) return Promise.resolve();

  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebRTC signaling open failed")), {
      once: true,
    });
  });
}

function waitForDataChannelOpen(dataChannel: RTCDataChannel): Promise<void> {
  if (dataChannel.readyState === "open") return Promise.resolve();

  return new Promise((resolve, reject) => {
    dataChannel.addEventListener("open", () => resolve(), { once: true });
    dataChannel.addEventListener("error", () => reject(new Error("DataChannel open failed")), {
      once: true,
    });
  });
}

function waitForPeerDataChannelsOpen(state: PeerState): Promise<void> {
  return Promise.all(
    TRANSPORT_CHANNELS.map((channel) => {
      const dataChannel = state.dataChannels[channel];
      if (!dataChannel) return Promise.reject(new Error(`Missing ${channel} DataChannel`));
      return waitForDataChannelOpen(dataChannel);
    }),
  ).then(() => undefined);
}
