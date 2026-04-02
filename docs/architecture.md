# Architecture

## Deployment shape

The dashboard now runs inside an Electron shell on macOS. The current deployment shape is LAN-first:

- `apps/desktop` hosts the operator UI
- `apps/server` receives heartbeats and serves queue snapshots
- `apps/agent` runs on each Mirage workstation

That means a practical local deployment is:

1. one central Mac runs the ingest/query API
2. each Mirage Mac runs the queue agent
3. one or more operators open the Electron dashboard

If you want remote access later, the API can still be moved to hosted infrastructure.

Reasonable hosted API options later:

- Cloudflare Workers
- Fly.io
- Render
- Railway
- a small VPS

## Proposed v1 data flow

1. each Mirage workstation runs a local agent
2. the agent reads local queue state from Mirage or Mirage spool files
3. the agent posts a heartbeat to `/api/heartbeat`
4. the server stores the latest snapshot per machine and printer
5. the dashboard reads `/api/queues`

## Shared model

The shared package currently defines:

- `QueueJob`
- `PrinterQueue`
- `AgentHeartbeat`
- `DashboardSnapshot`

This keeps the agent, server, and dashboard aligned.

## Desktop app implications

The React dashboard remains its own app in `apps/dashboard`, and the Electron shell in `apps/desktop` loads it in two modes:

- development: from the Vite dev server
- runtime: from the built `apps/dashboard/dist/index.html`

The desktop shell passes a runtime API base URL into the renderer. By default it uses `http://127.0.0.1:8787`, but you can point it at another LAN machine with `ELECTRON_API_BASE_URL`.

The desktop app also exposes installer actions through Electron IPC so the UI can install/uninstall local LaunchAgent services for:

- queue agent
- ingest API server

## Mirage integration assumption

Current assumption for v1:

- Mirage queue state is available locally, not through a supported public web API
- the agent will likely inspect Mirage spool/queue artifacts on disk and translate them into `AgentHeartbeat`

We should verify this on one real workstation before committing to the full agent implementation.
