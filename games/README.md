# Game Catalog

The generic service reads `games/catalog.json` to show the games that can be
served from the dashboard.

Add a new static game by placing it under `games/<id>/`, for example:

```text
games/
  qix/
    index.html
    assets/
```

Then register it:

```json
{
  "games": [
    {
      "id": "qix",
      "title": "QIX",
      "entry": "/games/qix/index.html",
      "description": "Local multiplayer QIX demo"
    }
  ]
}
```

The `entry` path must be reachable by the service HTTP server. The game can then
derive its WebSocket signaling URL from the same host with `/ws`, or it can
receive an explicit `signaling=ws://.../ws` URL from a launcher page.
