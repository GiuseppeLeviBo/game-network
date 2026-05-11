import { EventSlot } from "./events.js";
import {
  PROTOCOL_VERSION,
  createEnvelope,
  isProtocolEnvelope,
  type GameEventEnvelope,
  type InputEnvelope,
  type JoinAcceptPayload,
  type JoinRejectPayload,
  type PlayerId,
  type PlayerInfo,
  type RoomId,
  type RoomInfo,
  type SnapshotEnvelope,
  type Unsubscribe,
} from "./protocol.js";
import type { GameNetworkTransport } from "./transport.js";
import { defaultMonotonicClock, type MonotonicClock } from "./clockSync.js";

export interface CreateHostRoomOptions<GameConfig = unknown> {
  roomId: RoomId;
  maxPlayers: number;
  displayName: string;
  gameConfig?: GameConfig;
  transport: GameNetworkTransport;
  assignPlayerId?: (index: number) => PlayerId;
  now?: MonotonicClock;
}

export interface JoinRoomOptions {
  roomId: RoomId;
  displayName: string;
  hostPeerId: string;
  transport: GameNetworkTransport;
  now?: MonotonicClock;
}

export class HostRoom<GameInput = unknown, GameSnapshot = unknown, GameEvent = unknown, GameConfig = unknown> {
  private readonly playerJoined = new EventSlot<[PlayerInfo]>();
  private readonly playerLeft = new EventSlot<[PlayerId, string | undefined]>();
  private readonly inputReceived = new EventSlot<[InputEnvelope<GameInput>]>();
  private readonly playersByPeerId = new Map<string, PlayerInfo>();
  private readonly playersById = new Map<PlayerId, PlayerInfo>();
  private hostSeq = 0;
  private status: RoomInfo<GameConfig>["status"] = "lobby";
  private readonly now: MonotonicClock;

  readonly roomId: RoomId;
  readonly localPlayer: PlayerInfo;

  constructor(private readonly options: CreateHostRoomOptions<GameConfig>) {
    if (options.maxPlayers < 1) {
      throw new Error("maxPlayers must be at least 1");
    }

    this.now = options.now ?? defaultMonotonicClock;
    this.roomId = options.roomId;
    this.localPlayer = {
      id: this.assignPlayerId(0),
      peerId: options.transport.localPeerId,
      displayName: options.displayName,
      isHost: true,
    };
    this.addPlayer(this.localPlayer);
    options.transport.onMessage((message) => this.handleMessage(message.fromPeerId, message.data));
    options.transport.onPeerDisconnected?.((peerId) => this.handlePeerDisconnected(peerId));
  }

  get players(): readonly PlayerInfo[] {
    return [...this.playersById.values()];
  }

  get roomInfo(): RoomInfo<GameConfig> {
    return {
      id: this.roomId,
      hostPeerId: this.localPlayer.peerId,
      maxPlayers: this.options.maxPlayers,
      status: this.status,
      players: [...this.players],
      gameConfig: this.options.gameConfig,
    };
  }

  start(): void {
    this.status = "running";
    this.broadcastRoomUpdate();
  }

  close(): void {
    this.status = "closed";
    this.broadcastRoomUpdate();
    this.options.transport.close();
  }

  sendSnapshot(snapshot: GameSnapshot): void {
    this.hostSeq += 1;
    this.options.transport.broadcast(
      "realtime",
      createEnvelope({
        type: "snapshot",
        roomId: this.roomId,
        senderPeerId: this.localPlayer.peerId,
        seq: this.hostSeq,
        sentAt: this.now(),
        payload: {
          hostSeq: this.hostSeq,
          snapshot,
        } satisfies SnapshotEnvelope<GameSnapshot>,
      }),
    );
  }

  sendEvent(event: GameEvent): void {
    this.hostSeq += 1;
    this.options.transport.broadcast(
      "control",
      createEnvelope({
        type: "game_event",
        roomId: this.roomId,
        senderPeerId: this.localPlayer.peerId,
        seq: this.hostSeq,
        sentAt: this.now(),
        payload: {
          hostSeq: this.hostSeq,
          event,
        } satisfies GameEventEnvelope<GameEvent>,
      }),
    );
  }

  onPlayerJoined(handler: (player: PlayerInfo) => void): Unsubscribe {
    return this.playerJoined.subscribe(handler);
  }

  onPlayerLeft(handler: (playerId: PlayerId, reason?: string) => void): Unsubscribe {
    return this.playerLeft.subscribe(handler);
  }

  onInput(handler: (input: InputEnvelope<GameInput>) => void): Unsubscribe {
    return this.inputReceived.subscribe(handler);
  }

  private handleMessage(fromPeerId: string, data: unknown): void {
    if (!isProtocolEnvelope(data) || data.roomId !== this.roomId) return;

    if (data.type === "join_request") {
      const payload = data.payload as { displayName?: unknown; clientProtocolVersion?: unknown };
      this.acceptOrRejectJoin(fromPeerId, payload);
      return;
    }

    if (data.type === "input") {
      const player = this.playersByPeerId.get(fromPeerId);
      if (!player) return;
      const receivedAt = this.now();
      const payload = addTimingMetadata(data.payload as InputEnvelope<GameInput>, data.sentAt, receivedAt);
      if (payload.playerId !== player.id) return;
      this.inputReceived.emit(payload);
    }
  }

  private acceptOrRejectJoin(
    peerId: string,
    payload: { displayName?: unknown; clientProtocolVersion?: unknown },
  ): void {
    if (payload.clientProtocolVersion !== PROTOCOL_VERSION) {
      this.sendJoinReject(peerId, "version_mismatch", "Protocol version mismatch");
      return;
    }

    if (this.status === "closed") {
      this.sendJoinReject(peerId, "closed", "Room is closed");
      return;
    }

    const existingPlayer = this.playersByPeerId.get(peerId);
    if (existingPlayer) {
      this.sendJoinAccept(peerId, existingPlayer);
      return;
    }

    if (this.players.length >= this.options.maxPlayers) {
      this.sendJoinReject(peerId, "room_full", "Room is full");
      return;
    }

    const player: PlayerInfo = {
      id: this.assignPlayerId(this.players.length),
      peerId,
      displayName: normalizeDisplayName(payload.displayName),
      isHost: false,
    };

    this.addPlayer(player);
    this.sendJoinAccept(peerId, player);
    this.playerJoined.emit(player);
    this.broadcastPlayerJoined(player);
  }

  private sendJoinAccept(peerId: string, player: PlayerInfo): void {
    this.options.transport.send(
      peerId,
      "control",
      createEnvelope({
        type: "join_accept",
        roomId: this.roomId,
        senderPeerId: this.localPlayer.peerId,
        sentAt: this.now(),
        payload: {
          localPlayer: player,
          room: this.roomInfo,
        } satisfies JoinAcceptPayload<GameConfig>,
      }),
    );
  }

  private sendJoinReject(peerId: string, reason: JoinRejectPayload["reason"], message: string): void {
    this.options.transport.send(
      peerId,
      "control",
      createEnvelope({
        type: "join_reject",
        roomId: this.roomId,
        senderPeerId: this.localPlayer.peerId,
        sentAt: this.now(),
        payload: {
          reason,
          message,
        } satisfies JoinRejectPayload,
      }),
    );
  }

  private broadcastPlayerJoined(player: PlayerInfo): void {
    this.options.transport.broadcast(
      "control",
      createEnvelope({
        type: "player_joined",
        roomId: this.roomId,
        senderPeerId: this.localPlayer.peerId,
        sentAt: this.now(),
        payload: {
          player,
          players: [...this.players],
        },
      }),
    );
  }

  private broadcastRoomUpdate(): void {
    this.options.transport.broadcast(
      "control",
      createEnvelope({
        type: "room_update",
        roomId: this.roomId,
        senderPeerId: this.localPlayer.peerId,
        sentAt: this.now(),
        payload: this.roomInfo,
      }),
    );
  }

  private broadcastPlayerLeft(player: PlayerInfo, reason?: string): void {
    this.options.transport.broadcast(
      "control",
      createEnvelope({
        type: "player_left",
        roomId: this.roomId,
        senderPeerId: this.localPlayer.peerId,
        sentAt: this.now(),
        payload: {
          playerId: player.id,
          reason,
          players: [...this.players],
        },
      }),
    );
  }

  private addPlayer(player: PlayerInfo): void {
    this.playersByPeerId.set(player.peerId, player);
    this.playersById.set(player.id, player);
  }

  private removePlayerByPeerId(peerId: string): PlayerInfo | undefined {
    const player = this.playersByPeerId.get(peerId);
    if (!player || player.isHost) return undefined;
    this.playersByPeerId.delete(peerId);
    this.playersById.delete(player.id);
    return player;
  }

  private handlePeerDisconnected(peerId: string): void {
    const player = this.removePlayerByPeerId(peerId);
    if (!player) return;
    const reason = "peer_disconnected";
    this.playerLeft.emit(player.id, reason);
    this.broadcastPlayerLeft(player, reason);
  }

  private assignPlayerId(index: number): PlayerId {
    return this.options.assignPlayerId?.(index) ?? `player-${index + 1}`;
  }
}

export class GuestRoom<GameInput = unknown, GameSnapshot = unknown, GameEvent = unknown, GameConfig = unknown> {
  private readonly connected = new EventSlot<[JoinAcceptPayload<GameConfig>]>();
  private readonly rejected = new EventSlot<[JoinRejectPayload]>();
  private readonly hostDisconnected = new EventSlot<[]>();
  private readonly playersChanged = new EventSlot<[readonly PlayerInfo[]]>();
  private readonly snapshotReceived = new EventSlot<[SnapshotEnvelope<GameSnapshot>]>();
  private readonly eventReceived = new EventSlot<[GameEventEnvelope<GameEvent>]>();
  private clientSeq = 0;
  private room?: RoomInfo<GameConfig>;
  private readonly now: MonotonicClock;

  readonly roomId: RoomId;
  localPlayer?: PlayerInfo;

  constructor(private readonly options: JoinRoomOptions) {
    this.now = options.now ?? defaultMonotonicClock;
    this.roomId = options.roomId;
    options.transport.onMessage((message) => this.handleMessage(message.data));
    options.transport.onPeerDisconnected?.((peerId) => this.handlePeerDisconnected(peerId));
  }

  get players(): readonly PlayerInfo[] {
    return this.room?.players ?? [];
  }

  join(): void {
    this.options.transport.send(
      this.options.hostPeerId,
      "control",
      createEnvelope({
        type: "join_request",
        roomId: this.roomId,
        senderPeerId: this.options.transport.localPeerId,
        sentAt: this.now(),
        payload: {
          displayName: this.options.displayName,
          clientProtocolVersion: PROTOCOL_VERSION,
        },
      }),
    );
  }

  close(): void {
    this.options.transport.close();
  }

  sendInput(input: GameInput): void {
    if (!this.localPlayer) {
      throw new Error("Cannot send input before join_accept");
    }

    this.clientSeq += 1;
    this.options.transport.send(
      this.options.hostPeerId,
      "realtime",
      createEnvelope({
        type: "input",
        roomId: this.roomId,
        senderPeerId: this.options.transport.localPeerId,
        seq: this.clientSeq,
        sentAt: this.now(),
        payload: {
          playerId: this.localPlayer.id,
          clientSeq: this.clientSeq,
          input,
        } satisfies InputEnvelope<GameInput>,
      }),
    );
  }

  onConnected(handler: (payload: JoinAcceptPayload<GameConfig>) => void): Unsubscribe {
    return this.connected.subscribe(handler);
  }

  onRejected(handler: (payload: JoinRejectPayload) => void): Unsubscribe {
    return this.rejected.subscribe(handler);
  }

  onHostDisconnected(handler: () => void): Unsubscribe {
    return this.hostDisconnected.subscribe(handler);
  }

  onPlayersChanged(handler: (players: readonly PlayerInfo[]) => void): Unsubscribe {
    return this.playersChanged.subscribe(handler);
  }

  onSnapshot(handler: (snapshot: SnapshotEnvelope<GameSnapshot>) => void): Unsubscribe {
    return this.snapshotReceived.subscribe(handler);
  }

  onEvent(handler: (event: GameEventEnvelope<GameEvent>) => void): Unsubscribe {
    return this.eventReceived.subscribe(handler);
  }

  private handleMessage(data: unknown): void {
    if (!isProtocolEnvelope(data) || data.roomId !== this.roomId) return;

    if (data.type === "join_accept") {
      const payload = data.payload as JoinAcceptPayload<GameConfig>;
      this.localPlayer = payload.localPlayer;
      this.room = payload.room;
      this.connected.emit(payload);
      this.playersChanged.emit(payload.room.players);
      return;
    }

    if (data.type === "join_reject") {
      this.rejected.emit(data.payload as JoinRejectPayload);
      return;
    }

    if (data.type === "player_joined") {
      const payload = data.payload as { players: PlayerInfo[] };
      this.room = this.room ? { ...this.room, players: payload.players } : this.room;
      this.playersChanged.emit(payload.players);
      return;
    }

    if (data.type === "player_left") {
      const payload = data.payload as { players: PlayerInfo[] };
      this.room = this.room ? { ...this.room, players: payload.players } : this.room;
      this.playersChanged.emit(payload.players);
      return;
    }

    if (data.type === "room_update") {
      this.room = data.payload as RoomInfo<GameConfig>;
      this.playersChanged.emit(this.room.players);
      return;
    }

    if (data.type === "snapshot") {
      this.snapshotReceived.emit(addTimingMetadata(data.payload as SnapshotEnvelope<GameSnapshot>, data.sentAt, this.now()));
      return;
    }

    if (data.type === "game_event") {
      this.eventReceived.emit(addTimingMetadata(data.payload as GameEventEnvelope<GameEvent>, data.sentAt, this.now()));
    }
  }

  private handlePeerDisconnected(peerId: string): void {
    if (peerId !== this.options.hostPeerId) return;
    if (this.room?.status === "closed" && !this.localPlayer) return;
    if (this.room) {
      this.room = {
        ...this.room,
        status: "closed",
        players: this.room.players.filter((player) => player.peerId !== peerId),
      };
      this.playersChanged.emit(this.room.players);
    }
    this.localPlayer = undefined;
    this.hostDisconnected.emit();
  }
}

function addTimingMetadata<T extends { sentAt?: number; receivedAt?: number; oneWayDelayMs?: number }>(
  payload: T,
  sentAt: unknown,
  receivedAt: number,
): T {
  const next = { ...payload, receivedAt };
  if (typeof sentAt === "number" && Number.isFinite(sentAt)) {
    next.sentAt = sentAt;
    next.oneWayDelayMs = Math.max(0, receivedAt - sentAt);
  }
  return next;
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") return "Player";
  const trimmed = value.trim();
  return trimmed || "Player";
}
