# Deployment Guide

This guide explains how to run Game Network in LAN environments.

## Recommended Modes

### Home / Open LAN

Use:

```bash
npm run play:chess
```

Ports:

- HTTP dashboard/game/invite links: `9201`;
- WebSocket signaling: `/ws` on the same port.

This is the normal mode. The launcher prints the host IP and opens the browser
on the correct dashboard URL.

### School / University / Restricted LAN

Use:

```bash
npm run play:chess -- --port 80
```

or, as a convenience form:

```bash
npm run play:chess --port=80
```

`npm run service` starts the generic service in the same single-port mode. It
does not open the chess dashboard:

```bash
npm run service -- --port 80
```

Ports:

- HTTP dashboard/game: `80`;
- WebSocket signaling: `/ws` on the same port.

This mode is best when firewalls block non-standard ports.

Example guest URL:

```text
http://10.200.1.110/join/CHESS-A1B2
```

Internal WebSocket URL:

```text
ws://10.200.1.110/ws
```

## Running On Port 80

On Windows:

1. open PowerShell as administrator;
2. make sure no other service is using port `80`;
3. run:

```bash
cd path/to/Game_Network
npm run service -- --port 80
```

For the player-facing chess launcher on the same privileged port:

```bash
npm run play:chess -- --port 80
```

Check port usage:

```powershell
netstat -ano | findstr ":80"
```

Stop a process if needed:

```powershell
taskkill /PID NUMERO_PID /F
```

## Port 443

Port `443` requires TLS:

- HTTPS for normal pages;
- WSS for WebSocket signaling;
- a certificate trusted by clients.

This is not just a port change. The service needs HTTPS server support and
certificate configuration.

Possible future command:

```bash
node dist/src/gameLauncherCli.js --https --port 443 --cert cert.pem --key key.pem
```

For a managed deployment, the cleanest production option may be:

- Game Network service behind an existing HTTPS reverse proxy;
- proxy handles certificate and port `443`;
- Node service listens internally on a high port.

## Firewall Checklist

If clients cannot reach the host:

- verify the host IP printed by the launcher;
- verify the guest uses the same network/VLAN;
- use port `80` if non-standard ports are blocked;
- allow Node.js through Windows Firewall;
- check whether client isolation is enabled on Wi-Fi;
- check whether the network blocks peer-to-peer traffic between clients.

Single-port mode helps with blocked ports but cannot bypass Wi-Fi client
isolation. If the network prevents clients from reaching each other at all, the
service must run on an allowed server address.

## Service Versus Game Deployment

The desired long-term deployment is:

```text
Game Network service installed once
  serves one or more games
  exposes dashboard and invite links
  exposes WebSocket signaling

Games installed as packages or folders
  chess
  qix
  future games

Guests
  browser only
```

In that model, adding a new game should mean registering a manifest, not writing
a new network service.
