# QueueMaster

Single-file Python app for Mirage queue visibility through a shared synced folder.

## What it does

The program has one job:

1. read Mirage queue data from the local Mac
2. write that workstation snapshot into a shared synced folder as JSON
3. read every workstation snapshot from the same shared synced folder
4. serve a local dashboard in the browser

There is no central ingest server anymore. The shared folder is the transport layer.

## Files

- `queuemaster.py` - the entire app

## Requirements

- Python 3.10+
- Dropbox Desktop installed and syncing a shared folder on each Mac
- Mirage installed on any Mac that should publish its own queue state

No Dropbox API integration is required for this setup. QueueMaster reads and writes local files, and Dropbox handles cross-device sync in the background.

On first launch, QueueMaster opens a folder picker so you can choose the shared synced folder. That selection is then saved locally for later launches.

## Default Mirage paths

The app uses these defaults unless you override them:

- Mirage config: `~/Library/Preferences/de.dinax.mirage.config`
- Mirage queue: `~/Library/Application Support/Mirage/Mirage Queue`

## Quick start

Run this on a workstation that should both publish and show the dashboard:

```bash
python3 queuemaster.py
```

The first launch will prompt you to pick the shared Dropbox folder. After that, the saved folder is reused automatically.

Then open:

```text
http://127.0.0.1:8866
```

## Useful modes

Publish only on a Mirage workstation:

```bash
python3 queuemaster.py --mode publish
```

Dashboard only on a Mac that should not read local Mirage data:

```bash
python3 queuemaster.py --mode dashboard
```

## Useful options

- the shared folder is selected with a dialog on first launch and saved locally
- `--shared-dir` still works as an override when needed
- `--machine-id` sets the stable file name written into the shared folder
- `--machine-name` changes the dashboard label for the workstation
- `--location` sets the workstation location label
- `--mirage-config-path` overrides the Mirage config file path
- `--mirage-queue-path` overrides the Mirage queue directory
- `--poll-interval-seconds` changes how often the workstation writes its snapshot
- `--dashboard-host` changes the bind address
- `--dashboard-port` changes the local dashboard port
- `--refresh-seconds` changes the dashboard auto-refresh interval

## Snapshot format

Each workstation writes one JSON file into the shared folder. The filename is derived from `machine_id`, for example:

```text
mac-studio-a.json
```

The file contains:

- workstation identity
- timestamp of the last successful scan
- printer queues
- queue jobs discovered from Mirage queue metadata

## Current assumptions

- Dropbox sync is reliable enough for the snapshot-sharing layer
- JSON is the transport format
- one file per workstation is simpler than a shared aggregate file
- Mirage queue metadata still uses the same local config and queue directory pattern already discovered in the previous version

## Compatibility

- `--dropbox-dir` still works as a legacy alias for `--shared-dir`
- `DROPBOX_QUEUE_DIR` still works as a legacy environment variable
- `SHARED_QUEUE_DIR` is the preferred environment variable going forward
- the saved folder preference is stored in `~/Library/Application Support/QueueMaster/settings.json`

## Validation

Basic syntax check:

```bash
python3 -m py_compile queuemaster.py
```
