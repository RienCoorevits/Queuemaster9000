# Mirage Discovery

This repository now has a first real Mirage integration path based on what exists on this Mac.

## Observed locally

- Mirage app is installed
- Mirage queue monitor is installed
- Mirage config exists at `~/Library/Preferences/de.dinax.mirage.config`
- Mirage queue directory is configured as `~/Library/Application Support/Mirage/Mirage Queue/`
- the queue directory currently exists but is empty except for `_archive`

## Useful confirmed config keys

- `queue.directory.path`
- `queue.maxparalleljobs`
- `printers.N.desc`
- `printers.N.type`
- `printers.N.tcp.address`
- `printers.N.uuid`
- `settings.selectedPrinter`

## Useful confirmed documentation

Mirage's local manual says:

- every print job is spooled to disk
- the print queue controls all Mirage jobs
- queued jobs show status, title, media type, and application
- paused jobs can survive restart if the queue target is a persistent folder

## Useful binary evidence

The installed Queue Monitor binary contains strings that strongly suggest queued jobs store XML and preview artifacts such as:

- `meta.xml`
- `status.xml`
- `media.xml`
- `page_preview.png`
- `jobInfo.jobTitle`
- `jobInfo.applicationName`
- `jobInfo.printerName`
- `jobInfo.paperName`

## What the agent does now

The agent in `apps/agent/src/mirage.ts`:

1. reads `de.dinax.mirage.config`
2. discovers the configured queue directory
3. discovers enabled printers
4. scans queue job directories under the Mirage queue path
5. parses queue XML files when present
6. maps the result into the shared `AgentHeartbeat` schema

## Remaining uncertainty

The queue is empty right now, so the exact on-disk job bundle structure still needs to be validated against a live queued print job.

The current parser is intentionally tolerant:

- it scans any XML files in a queue job directory
- it extracts known fields by suffix match rather than hardcoding one exact XML tree

That should let us capture real jobs without needing a perfect reverse-engineered schema up front.
