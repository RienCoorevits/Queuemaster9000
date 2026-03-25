# Architecture

## Deployment shape

The dashboard is designed to be a static site so it can be deployed to GitHub Pages. That creates one hard constraint:

- `apps/dashboard` can be hosted on GitHub Pages
- `apps/server` cannot be hosted on GitHub Pages

That means production needs two deploy targets:

1. static dashboard
2. ingest/query API

Reasonable API hosting options later:

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

## GitHub Pages implications

The dashboard Vite config uses `/Queuemaster9000/` as the base path when `GITHUB_PAGES=true`. That avoids broken asset paths after deployment.

The dashboard also reads `VITE_API_BASE_URL`:

- if set, the UI queries the real API
- if absent, the UI renders mock data

This keeps local UI work unblocked before the ingest service is stable.

## Mirage integration assumption

Current assumption for v1:

- Mirage queue state is available locally, not through a supported public web API
- the agent will likely inspect Mirage spool/queue artifacts on disk and translate them into `AgentHeartbeat`

We should verify this on one real workstation before committing to the full agent implementation.
