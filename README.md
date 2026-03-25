# Queuemaster9000

Lightweight web app for monitoring Mirage print queues across multiple Macs.

## Goals

- run a small agent on each Mirage workstation
- normalize queue state into one shared schema
- push queue snapshots to a central ingest API
- host the dashboard as a static site on GitHub Pages

## Repo layout

- `apps/dashboard` - static React dashboard intended for GitHub Pages
- `apps/agent` - local macOS/Node agent that will read Mirage queue data
- `apps/server` - ingest API for heartbeats and queue snapshots
- `packages/shared` - shared queue types and mock data
- `docs/architecture.md` - deployment and integration notes

## Important constraint

GitHub Pages can only host the dashboard. The ingest API cannot live on GitHub Pages, so the long-term shape is:

1. GitHub Pages hosts the dashboard UI
2. a separate API receives heartbeats from the agents
3. the dashboard reads from that API

The dashboard already supports this shape through `VITE_API_BASE_URL`. If that variable is missing, it falls back to mock data.

## Getting started

```bash
npm install
npm run dev:dashboard
```

In another terminal, once dependencies are installed:

```bash
npm run dev:server
npm run dev:agent
npm run inspect --workspace @queuemaster/agent
npm run once --workspace @queuemaster/agent
```

## Next engineering question

Mirage does not appear to expose a public queue API, so the main technical task is to determine which local queue/spool files or process outputs on macOS are stable enough for the agent to read.

On this machine, the first real integration path is now wired up:

- Mirage config: `~/Library/Preferences/de.dinax.mirage.config`
- Mirage queue directory: `~/Library/Application Support/Mirage/Mirage Queue/`

The agent reads the config, discovers the printer list, scans the queue directory, and looks for job metadata in Mirage queue XML files such as `meta.xml` and `status.xml`.

## Local live flow

For local development, the dashboard proxies `/api` requests to the local server on `http://localhost:8787`, so the simplest live setup is:

1. run `npm run dev:server`
2. run `npm run dev:agent`
3. run `npm run dev:dashboard`

Useful agent options:

- `npm run inspect --workspace @queuemaster/agent` - print the current heartbeat JSON without posting it
- `npm run once --workspace @queuemaster/agent` - send one heartbeat immediately
- `POLL_INTERVAL_MS=5000 npm run dev:agent` - poll Mirage every 5 seconds
