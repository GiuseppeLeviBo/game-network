import { PeerServer } from "peer";

export interface StartPeerSignalingServerOptions {
  port: number;
  host?: string;
  path?: string;
  allowDiscovery?: boolean;
}

export function startPeerSignalingServer(options: StartPeerSignalingServerOptions): void {
  PeerServer({
    port: options.port,
    host: options.host ?? "127.0.0.1",
    path: options.path ?? "/game-network",
    allow_discovery: options.allowDiscovery ?? false,
  });
}

