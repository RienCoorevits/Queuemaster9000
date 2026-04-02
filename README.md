# Queuemaster9000

Desktop app for monitoring Mirage print queues across multiple Macs.

## Goals

- run a small agent on each Mirage workstation
- normalize queue state into one shared schema
- push queue snapshots to a central ingest API
- display the dashboard in an Electron window

## Repo layout

- `apps/dashboard` - React dashboard UI
- `apps/desktop` - Electron shell for the dashboard
- `apps/agent` - local macOS/Node agent that will read Mirage queue data
- `apps/server` - ingest API for heartbeats and queue snapshots
- `packages/shared` - shared queue types and mock data
- `docs/architecture.md` - deployment and integration notes

## Runtime shape

The current setup is LAN-first:

1. each Mirage workstation runs the local agent
2. one machine runs the ingest API
3. the operator opens the dashboard in the Electron app
4. the Electron app reads queue state from the API

## Getting started

```bash
npm install
npm run dev:desktop
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

For local development, the simplest live setup is:

1. run `npm run dev:server`
2. run `npm run dev:agent`
3. run `npm run dev:desktop`

Useful agent options:

- `npm run inspect --workspace @queuemaster/agent` - print the current heartbeat JSON without posting it
- `npm run once --workspace @queuemaster/agent` - send one heartbeat immediately
- `POLL_INTERVAL_MS=5000 npm run dev:agent` - poll Mirage every 5 seconds

Useful desktop options:

- `npm run dev:desktop` - start Vite and open the Electron window
- `npm run start:desktop` - open Electron against the built dashboard in `apps/dashboard/dist`
- `ELECTRON_API_BASE_URL=http://192.168.1.50:8787 npm run start:desktop` - point the desktop app at a LAN server

To start the main local stack in one command:

```bash
npm run dev:app
```

## In-app installation

The Electron dashboard includes local installer controls:

- `Install local agent` installs a LaunchAgent service on that machine.
- `Install local server` installs a LaunchAgent service on that machine.

Use this rollout model:

1. Pick one Mac to be the LAN server and click `Install local server`.
2. On each Mirage workstation, open the app and click `Install local agent`.
3. Set each agent's Server URL to `http://<server-ip>:8787`.

Installer runtime details:

- Runtime scripts are bundled to `apps/desktop/runtime/agent.mjs` and `apps/desktop/runtime/server.mjs`.
- Installed LaunchAgent files are created under `~/Library/LaunchAgents/`.
- Logs are written to `~/Library/Application Support/QueueMaster9000/logs/`.
