# Multiplayer Ecosystem Sandbox

This version removes Supabase/shared-species-library logic and replaces the browser-only sim with an authoritative WebSocket server.

## Run locally

```bash
npm install
npm start
```

Open:

```txt
http://localhost:3000
```

Everyone on the same server sees the same ecosystem. The browser sends only commands like `release_species`; the server owns all plant/animal positions, energy, births, deaths, and predation.

## Deploy to Render

1. Push this folder to a GitHub repository.
2. Render > New > Web Service.
3. Connect the repo.
4. Use:

```txt
Build command: npm install
Start command: npm start
```

5. Open the Render URL. Share that same URL with friends.

## Optional persistence across server restarts

By default, the world is stored in memory. If the server restarts, the world resets.

To save snapshots to a local file, set environment variables:

```txt
SAVE_WORLD=1
WORLD_SAVE_PATH=/var/data/world_snapshot.json
```

On Render, this only survives redeploys/restarts if you attach a persistent disk mounted at `/var/data`. Without a disk, the filesystem is ephemeral.

## What files do

- `server.js`: authoritative simulation + WebSocket broadcast server.
- `public/index.html`: multiplayer client UI and renderer.
- `package.json`: Node dependencies and start script.
