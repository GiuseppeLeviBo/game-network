# Chess Player Guide

This guide is for the player, teacher, or presenter who wants to run the chess
example without explaining technical parameters to the guest.

## Goal

One machine acts as the host. It runs the Game Network launcher and opens the
host board. Other players open an invite link in a browser. They do not install
anything.

## Normal LAN Mode

On the host machine:

```bash
cd path/to/Game_Network
npm run play:chess
```

The launcher starts:

- HTTP dashboard, game server and invite links on port `9201`;
- WebSocket signaling on `/ws` on the same port;
- the browser dashboard.

In the dashboard:

1. keep the generated room code or click **Nuova stanza**;
2. choose whether the host plays white or black;
3. click **Apri partita host**;
4. click **Copia link**;
5. send the copied link to the guest.

The guest opens a link shaped like:

```text
http://192.168.0.197:9201/join/CHESS-A1B2
```

The guest page hides the technical parameters and opens the configured chess
client.

## Port 80 For Restricted Networks

Some managed networks block non-standard ports. The launcher is
already single-port; in that case run the same launcher on port `80`:

```bash
npm run play:chess -- --port 80
```

This shorter npm form is also supported:

```bash
npm run play:chess --port=80
```

This uses one HTTP port for everything:

- dashboard;
- game files;
- invite links;
- WebSocket signaling on `/ws`.

The guest link becomes:

```text
http://192.168.0.197/join/CHESS-A1B2
```

On Windows, port `80` may require an administrator shell. If port `80` is busy,
use a different port for testing:

```bash
npm run play:chess -- --port 8080
```

## Copy Link And QR

The primary invitation method is **Copia link**, then send it by WhatsApp, mail,
Teams, or another messaging tool.

The **Mostra QR** button is optional. It is useful mainly for games designed for
phone or tablet. For desktop chess, copy-link is usually better.

## What The Guest Needs

Only:

- same LAN or reachable network path to the host;
- a modern browser;
- the invite link.

No Node.js, no npm, no repository clone, no install.

## What The Host Must Keep Open

Keep the launcher terminal open. If the host presses `Ctrl+C`, the local server
and signaling stop. Guests should then see the connection panel change to
`Disconnesso`.

## Troubleshooting

If the guest cannot open the link:

- check that both machines are on the same network;
- try port `80` if the network blocks non-standard ports;
- check Windows Firewall for Node.js;
- make sure another process is not already using the selected port.

If the guest opens the page but does not connect:

- verify that the host chess page is open;
- use a new room code;
- refresh both host and guest pages;
- check that the dashboard and the chess page show the same room code.
