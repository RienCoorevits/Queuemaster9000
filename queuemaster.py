#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
import xml.etree.ElementTree as ET


APP_VERSION = "1.0.0"
DEFAULT_POLL_INTERVAL_SECONDS = 10
DEFAULT_DASHBOARD_PORT = 8866
DEFAULT_REFRESH_SECONDS = 5
DEFAULT_STALE_AFTER_MINUTES = 2
DEFAULT_CONFIG_PATH = (
    Path.home() / "Library" / "Preferences" / "de.dinax.mirage.config"
)
DEFAULT_QUEUE_PATH = (
    Path.home()
    / "Library"
    / "Application Support"
    / "Mirage"
    / "Mirage Queue"
)
DEFAULT_SETTINGS_PATH = (
    Path.home()
    / "Library"
    / "Application Support"
    / "QueueMaster"
    / "settings.json"
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Publish Mirage queue snapshots into a shared synced folder and "
            "serve a local dashboard from the same folder."
        )
    )
    parser.add_argument(
        "--shared-dir",
        "--dropbox-dir",
        dest="shared_dir",
        default=(
            os.environ.get("SHARED_QUEUE_DIR")
            or os.environ.get("DROPBOX_QUEUE_DIR", "")
        ),
        help=(
            "Shared synced folder used for workstation snapshots. "
            "A Dropbox shared folder works with the current sync-based setup."
        ),
    )
    parser.add_argument(
        "--mode",
        choices=["all", "publish", "dashboard"],
        default=os.environ.get("QUEUEMASTER_MODE", "all"),
        help="Run both publisher and dashboard, or only one side.",
    )
    parser.add_argument(
        "--machine-id",
        default=os.environ.get("MACHINE_ID", socket.gethostname()),
        help="Stable machine identifier used for this workstation snapshot.",
    )
    parser.add_argument(
        "--machine-name",
        default=os.environ.get("MACHINE_NAME", socket.gethostname()),
        help="Display name for this workstation.",
    )
    parser.add_argument(
        "--location",
        default=os.environ.get("LOCATION", "Unknown"),
        help="Human-readable workstation location.",
    )
    parser.add_argument(
        "--mirage-config-path",
        default=os.environ.get("MIRAGE_CONFIG_PATH", str(DEFAULT_CONFIG_PATH)),
        help="Path to de.dinax.mirage.config.",
    )
    parser.add_argument(
        "--mirage-queue-path",
        default=os.environ.get("MIRAGE_QUEUE_PATH", ""),
        help="Optional override for the Mirage queue directory.",
    )
    parser.add_argument(
        "--poll-interval-seconds",
        type=int,
        default=int(
            os.environ.get(
                "POLL_INTERVAL_SECONDS", str(DEFAULT_POLL_INTERVAL_SECONDS)
            )
        ),
        help="Seconds between snapshot writes.",
    )
    parser.add_argument(
        "--dashboard-host",
        default=os.environ.get("DASHBOARD_HOST", "127.0.0.1"),
        help="Bind address for the local dashboard server.",
    )
    parser.add_argument(
        "--dashboard-port",
        type=int,
        default=int(
            os.environ.get("DASHBOARD_PORT", str(DEFAULT_DASHBOARD_PORT))
        ),
        help="Port for the local dashboard server.",
    )
    parser.add_argument(
        "--refresh-seconds",
        type=int,
        default=int(
            os.environ.get("REFRESH_SECONDS", str(DEFAULT_REFRESH_SECONDS))
        ),
        help="Dashboard auto-refresh interval in seconds.",
    )
    parser.add_argument(
        "--stale-after-minutes",
        type=int,
        default=int(
            os.environ.get(
                "STALE_AFTER_MINUTES", str(DEFAULT_STALE_AFTER_MINUTES)
            )
        ),
        help="Mark workstations stale after this many minutes.",
    )
    args = parser.parse_args()

    if args.poll_interval_seconds <= 0:
        parser.error("--poll-interval-seconds must be greater than 0")
    if args.dashboard_port <= 0 or args.dashboard_port > 65535:
        parser.error("--dashboard-port must be between 1 and 65535")
    if args.refresh_seconds <= 0:
        parser.error("--refresh-seconds must be greater than 0")
    if args.stale_after_minutes <= 0:
        parser.error("--stale-after-minutes must be greater than 0")

    return args


def load_settings(settings_path: Path = DEFAULT_SETTINGS_PATH) -> dict[str, Any]:
    try:
        raw = json.loads(settings_path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return raw if isinstance(raw, dict) else {}


def save_settings(
    settings: dict[str, Any], settings_path: Path = DEFAULT_SETTINGS_PATH
) -> None:
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        delete=False,
        dir=settings_path.parent,
        prefix=f".{settings_path.stem}-",
        suffix=".tmp",
    ) as handle:
        json.dump(settings, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temp_path = Path(handle.name)
    temp_path.replace(settings_path)


def is_usable_shared_dir(path: Path) -> bool:
    return path.exists() or path.parent.exists()


def choose_shared_dir_with_tk(initial_dir: Path | None = None) -> Path | None:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception:
        return None

    try:
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
    except Exception:
        return None

    dialog_options: dict[str, Any] = {
        "title": "Select the QueueMaster shared folder",
        "mustexist": False,
        "parent": root,
    }
    if initial_dir is not None and initial_dir.exists():
        dialog_options["initialdir"] = str(initial_dir)

    try:
        selected = filedialog.askdirectory(**dialog_options)
    finally:
        root.destroy()

    if not selected:
        return None
    return Path(selected).expanduser()


def choose_shared_dir_with_osascript() -> Path | None:
    script = (
        'POSIX path of (choose folder with prompt '
        '"Select the QueueMaster shared folder")'
    )
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None

    selected = result.stdout.strip()
    if not selected:
        return None
    return Path(selected).expanduser()


def prompt_for_shared_dir(initial_dir: Path | None = None) -> Path | None:
    selected = choose_shared_dir_with_tk(initial_dir)
    if selected is not None:
        return selected
    return choose_shared_dir_with_osascript()


def resolve_shared_dir(args: argparse.Namespace) -> Path:
    settings = load_settings()
    provided_dir = (args.shared_dir or "").strip()
    if provided_dir:
        shared_dir = Path(provided_dir).expanduser()
        settings["shared_dir"] = str(shared_dir)
        save_settings(settings)
        return shared_dir

    saved_dir = settings.get("shared_dir")
    if isinstance(saved_dir, str) and saved_dir.strip():
        candidate = Path(saved_dir).expanduser()
        if is_usable_shared_dir(candidate):
            return candidate

    initial_dir = None
    if isinstance(saved_dir, str) and saved_dir.strip():
        initial_dir = Path(saved_dir).expanduser()
    elif (Path.home() / "Dropbox").exists():
        initial_dir = Path.home() / "Dropbox"

    shared_dir = prompt_for_shared_dir(initial_dir)
    if shared_dir is None:
        raise SystemExit(
            "QueueMaster needs a shared folder selection before it can start."
        )

    settings["shared_dir"] = str(shared_dir)
    save_settings(settings)
    print("Using shared folder %s" % shared_dir, flush=True)
    return shared_dir


def parse_boolean(value: str | None, fallback: bool = False) -> bool:
    if value is None:
        return fallback
    return value.strip().lower() == "true"


def normalize_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def parse_scalar_value(value: str) -> str:
    return value.strip()


def collect_leaf_values(
    node: Any, prefix: str = "", output: dict[str, str] | None = None
) -> dict[str, str]:
    if output is None:
        output = {}

    if node is None:
        return output

    if isinstance(node, (str, int, float, bool)):
        value = str(node).strip()
        if value:
            output[prefix] = value
        return output

    if isinstance(node, dict):
        for key, value in node.items():
            next_prefix = f"{prefix}.{key}" if prefix else str(key)
            collect_leaf_values(value, next_prefix, output)
        return output

    if isinstance(node, list):
        for index, value in enumerate(node):
            next_prefix = f"{prefix}.{index}" if prefix else str(index)
            collect_leaf_values(value, next_prefix, output)
        return output

    return output


def collect_xml_leaf_values(
    element: ET.Element,
    prefix: str = "",
    output: dict[str, str] | None = None,
) -> dict[str, str]:
    if output is None:
        output = {}

    tag_name = element.tag.split("}", 1)[-1]
    base_prefix = prefix or tag_name
    children = list(element)

    text_value = (element.text or "").strip()
    if text_value:
        output[base_prefix] = text_value
        output.setdefault(tag_name, text_value)

    for attribute_name, attribute_value in element.attrib.items():
        clean_attribute = attribute_name.split("}", 1)[-1]
        output[f"{base_prefix}.@{clean_attribute}"] = attribute_value

    if not children:
        return output

    sibling_counts: dict[str, int] = {}
    for child in children:
        child_tag = child.tag.split("}", 1)[-1]
        sibling_counts[child_tag] = sibling_counts.get(child_tag, 0) + 1

    seen_counts: dict[str, int] = {}
    for child in children:
        child_tag = child.tag.split("}", 1)[-1]
        seen_counts[child_tag] = seen_counts.get(child_tag, 0) + 1
        child_prefix = f"{base_prefix}.{child_tag}"
        collect_xml_leaf_values(child, child_prefix, output)

        if sibling_counts[child_tag] > 1:
            indexed_prefix = f"{base_prefix}.{child_tag}.{seen_counts[child_tag] - 1}"
            collect_xml_leaf_values(child, indexed_prefix, output)

    return output


def first_matching_value(
    metadata: dict[str, str], candidates: list[str]
) -> str | None:
    for candidate in candidates:
        normalized_candidate = normalize_key(candidate)
        for key, value in metadata.items():
            if normalize_key(key).endswith(normalized_candidate):
                return value
    return None


def matching_values(metadata: dict[str, str], candidate: str) -> list[str]:
    normalized_candidate = normalize_key(candidate)
    values: list[str] = []
    for key, value in metadata.items():
        if normalize_key(key).endswith(normalized_candidate):
            parsed = parse_scalar_value(value)
            if parsed:
                values.append(parsed)
    return values


def collect_matching_values(
    metadata: dict[str, str], candidates: list[str]
) -> list[str]:
    values: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        for value in matching_values(metadata, candidate):
            normalized = value.strip().lower()
            if normalized in seen:
                continue
            seen.add(normalized)
            values.append(value)
    return values


def normalize_timestamp(value: str | None, fallback: str) -> str:
    if not value:
        return fallback

    candidate = value.strip()
    if candidate.endswith("Z"):
        candidate = candidate[:-1] + "+00:00"

    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return fallback

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)

    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def classify_status_signal(raw_value: str) -> tuple[str, int] | None:
    value = raw_value.strip().lower()
    if not value:
        return None

    if any(signal in value for signal in ("error", "warn", "fail")):
        return ("error", 100)
    if any(signal in value for signal in ("pause", "hold")):
        return ("paused", 90)
    if any(
        signal in value
        for signal in ("print", "render", "raster", "run", "process")
    ):
        return ("printing", 80)
    if any(signal in value for signal in ("spool", "rip")):
        return ("spooling", 70)
    if any(signal in value for signal in ("done", "complete", "finished")):
        return ("done", 60)
    if any(signal in value for signal in ("queue", "wait", "pending")):
        return ("queued", 50)
    if value == "true":
        return ("spooling", 5)
    if value in ("false", "0"):
        return ("queued", 1)

    return None


def normalize_status(raw_statuses: list[str]) -> tuple[str, str | None]:
    if not raw_statuses:
        return ("queued", None)

    best_status = "queued"
    best_weight = -1
    for raw_status in raw_statuses:
        classified = classify_status_signal(raw_status)
        if classified is None:
            continue
        status, weight = classified
        if weight > best_weight:
            best_status = status
            best_weight = weight

    raw_status = (
        " | ".join(raw_statuses[:3]) + " ..."
        if len(raw_statuses) > 3
        else " | ".join(raw_statuses)
    )
    return (best_status, raw_status)


def load_config(config_path: Path) -> dict[str, Any]:
    config_text = config_path.read_text(encoding="utf-8")
    entries: dict[str, str] = {}

    for line in config_text.splitlines():
        separator_index = line.find(":")
        if separator_index == -1:
            continue
        key = line[:separator_index].strip()
        value = line[separator_index + 1 :].strip()
        if key:
            entries[key] = value

    printer_indexes: set[int] = set()
    for key in entries:
        match = re.match(r"^printers\.(\d+)\.", key)
        if match:
            printer_indexes.add(int(match.group(1)))

    printers: list[dict[str, Any]] = []
    for index in sorted(printer_indexes):
        name = entries.get(f"printers.{index}.desc", f"Printer {index + 1}")
        printer = {
            "id": entries.get(f"printers.{index}.uuid", f"printer-{index}"),
            "index": index,
            "name": name,
            "type": entries.get(f"printers.{index}.type", name),
            "enabled": parse_boolean(
                entries.get(f"printers.{index}.enabled"), True
            ),
            "address": entries.get(f"printers.{index}.tcp.address"),
            "uuid": entries.get(f"printers.{index}.uuid"),
        }
        if printer["enabled"]:
            printers.append(printer)

    queue_directory_path = Path(
        entries.get("queue.directory.path", str(DEFAULT_QUEUE_PATH))
    )

    return {
        "config_path": str(config_path),
        "queue_directory_path": str(queue_directory_path),
        "printers": printers,
    }


def parse_xml_file(file_path: Path) -> dict[str, str]:
    tree = ET.parse(file_path)
    root = tree.getroot()
    return collect_xml_leaf_values(root)


def parse_key_value_file(file_path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    text = file_path.read_text(encoding="utf-8")
    for line in text.splitlines():
        separator_index = line.find(":")
        if separator_index == -1:
            continue
        key = line[:separator_index].strip()
        value = parse_scalar_value(line[separator_index + 1 :])
        if key and value:
            values[key] = value
    return values


def parse_metadata_file(file_path: Path) -> dict[str, str]:
    try:
        if file_path.suffix.lower() == ".xml":
            return parse_xml_file(file_path)
        return parse_key_value_file(file_path)
    except Exception:
        return {}


def read_job_candidate(directory_path: Path) -> dict[str, Any]:
    stat_result = directory_path.stat()
    metadata: dict[str, str] = {}
    entries = sorted(directory_path.iterdir(), key=lambda entry: entry.name.lower())

    for entry in entries:
        if not entry.is_file():
            continue
        values = parse_metadata_file(entry)
        for key, value in values.items():
            metadata[f"{entry.name}.{key}"] = value
            metadata[key] = value

    for entry in entries:
        if not entry.is_dir():
            continue
        nested_entries = sorted(entry.iterdir(), key=lambda child: child.name.lower())
        for nested_entry in nested_entries:
            if not nested_entry.is_file() or nested_entry.suffix.lower() != ".xml":
                continue
            values = parse_metadata_file(nested_entry)
            for key, value in values.items():
                metadata[f"{entry.name}/{nested_entry.name}.{key}"] = value
                metadata[f"{nested_entry.name}.{key}"] = value
                metadata.setdefault(key, value)

    return {
        "directory_path": str(directory_path),
        "sort_key": stat_result.st_mtime,
        "metadata": metadata,
    }


def pick_printer_name(
    candidate: dict[str, Any], printers: list[dict[str, Any]]
) -> str | None:
    printer_name = first_matching_value(
        candidate["metadata"], ["jobInfo.printerName", "printerName"]
    )
    if not printer_name:
        return None

    normalized_name = printer_name.lower()
    for printer in printers:
        if (
            printer["name"].lower() == normalized_name
            or printer["type"].lower() == normalized_name
        ):
            return printer["name"]

    return printer_name


def to_queue_job(candidate: dict[str, Any], position: int) -> dict[str, Any]:
    metadata = candidate["metadata"]
    fallback_timestamp = datetime.fromtimestamp(
        candidate["sort_key"], timezone.utc
    ).isoformat().replace("+00:00", "Z")
    raw_statuses = collect_matching_values(
        metadata,
        [
            "consumer.progress.pagePhase",
            "consumer.progress.status",
            "status",
            "jobStatus",
            "jobInfo.jobStatus",
            "state",
            "producer.active",
        ],
    )
    normalized_status, raw_status = normalize_status(raw_statuses)
    page_description = first_matching_value(
        metadata, ["pageDescription.0", "pageDescription"]
    )
    job_title = first_matching_value(
        metadata, ["jobInfo.jobTitle", "jobTitle", "title"]
    )
    file_name = (
        job_title
        or (
            page_description.split(" - Page ")[0].split("/")[-1]
            if page_description
            else None
        )
        or Path(candidate["directory_path"]).name
    )

    return {
        "job_id": first_matching_value(
            metadata,
            ["jobInfo.jobUniqueID", "jobID", "jobId", "ID.jobID"],
        )
        or Path(candidate["directory_path"]).name,
        "file_name": file_name,
        "source": first_matching_value(
            metadata, ["jobInfo.applicationName", "applicationName"]
        )
        or "Mirage",
        "status": normalized_status,
        "position": position,
        "submitted_at": normalize_timestamp(
            first_matching_value(metadata, ["jobInfo.printDate", "printDate"]),
            fallback_timestamp,
        ),
        "paper_name": first_matching_value(
            metadata,
            [
                "jobInfo.paperName",
                "paperName",
                "printerSettings.mediaType",
                "mediaType",
            ],
        ),
        "source_path": candidate["directory_path"],
        "raw_status": raw_status,
    }


def scan_queue_directory(
    queue_directory_path: Path, printers: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    queues: dict[str, dict[str, Any]] = {
        printer["name"]: {
            "printer_id": printer["id"],
            "printer_name": printer["name"],
            "queue_paused": False,
            "jobs": [],
        }
        for printer in printers
    }

    if not queue_directory_path.exists():
        return list(queues.values())

    candidates = [
        read_job_candidate(entry)
        for entry in sorted(queue_directory_path.iterdir(), key=lambda item: item.name)
        if entry.is_dir() and entry.name != "_archive"
    ]
    sorted_candidates = sorted(candidates, key=lambda candidate: candidate["sort_key"])

    for candidate in sorted_candidates:
        printer_name = pick_printer_name(candidate, printers)
        queue = None
        if printer_name:
            queue = queues.get(printer_name)
        if queue is None and queues:
            queue = next(iter(queues.values()))
        if queue is None:
            queue = {
                "printer_id": "unassigned",
                "printer_name": "Unassigned",
                "queue_paused": False,
                "jobs": [],
            }
            queues[queue["printer_name"]] = queue

        queue["jobs"].append(to_queue_job(candidate, len(queue["jobs"]) + 1))

    return list(queues.values())


def build_local_snapshot(args: argparse.Namespace) -> dict[str, Any]:
    config_path = Path(args.mirage_config_path).expanduser()
    config = load_config(config_path)
    queue_directory_path = (
        Path(args.mirage_queue_path).expanduser()
        if args.mirage_queue_path
        else Path(config["queue_directory_path"]).expanduser()
    )
    queues = scan_queue_directory(queue_directory_path, config["printers"])
    return {
        "machine_id": args.machine_id,
        "machine_name": args.machine_name,
        "location": args.location,
        "last_seen_at": utc_now_iso(),
        "app_version": APP_VERSION,
        "mirage_config_path": str(config_path),
        "mirage_queue_path": str(queue_directory_path),
        "queues": queues,
    }


def snapshot_file_path(shared_dir: Path, machine_id: str) -> Path:
    safe_id = re.sub(r"[^A-Za-z0-9._-]", "_", machine_id)
    return shared_dir / f"{safe_id}.json"


def write_snapshot(shared_dir: Path, snapshot: dict[str, Any]) -> Path:
    shared_dir.mkdir(parents=True, exist_ok=True)
    target_path = snapshot_file_path(shared_dir, snapshot["machine_id"])
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        delete=False,
        dir=shared_dir,
        prefix=f".{target_path.stem}-",
        suffix=".tmp",
    ) as handle:
        json.dump(snapshot, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temp_path = Path(handle.name)
    temp_path.replace(target_path)
    return target_path


def read_snapshot_files(shared_dir: Path) -> list[dict[str, Any]]:
    if not shared_dir.exists():
        return []

    snapshots: list[dict[str, Any]] = []
    for file_path in sorted(shared_dir.glob("*.json")):
        try:
            raw = json.loads(file_path.read_text(encoding="utf-8"))
        except Exception:
            continue

        if not isinstance(raw, dict):
            continue
        if "machine_id" not in raw or "queues" not in raw:
            continue

        snapshots.append(raw)

    snapshots.sort(key=lambda snapshot: snapshot.get("machine_name", ""))
    return snapshots


def build_aggregate_snapshot(shared_dir: Path) -> dict[str, Any]:
    return {
        "generated_at": utc_now_iso(),
        "machines": read_snapshot_files(shared_dir),
    }


def parse_timestamp(timestamp: str) -> datetime | None:
    candidate = timestamp.strip()
    if candidate.endswith("Z"):
        candidate = candidate[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def is_machine_stale(timestamp: str, stale_after_minutes: int) -> bool:
    parsed = parse_timestamp(timestamp)
    if parsed is None:
        return True
    age_seconds = (datetime.now(timezone.utc) - parsed).total_seconds()
    return age_seconds > stale_after_minutes * 60


def format_relative_age(timestamp: str) -> str:
    parsed = parse_timestamp(timestamp)
    if parsed is None:
        return "unknown"

    seconds = max(
        0,
        round((datetime.now(timezone.utc) - parsed).total_seconds()),
    )
    if seconds < 60:
        return f"{seconds}s ago"
    minutes = round(seconds / 60)
    if minutes < 60:
        return f"{minutes}m ago"
    hours = round(minutes / 60)
    if hours < 24:
        return f"{hours}h ago"
    days = round(hours / 24)
    return f"{days}d ago"


def summarize_printers(
    machines: list[dict[str, Any]], stale_after_minutes: int
) -> list[dict[str, Any]]:
    printers_by_key: dict[str, dict[str, Any]] = {}
    for machine in machines:
        for queue in machine.get("queues", []):
            printer_key = (queue.get("printer_name") or queue.get("printer_id") or "").strip().lower()
            printer = printers_by_key.get(printer_key)
            if printer is None:
                printer = {
                    "printer_id": queue.get("printer_id", "unknown"),
                    "printer_name": queue.get("printer_name", "Unknown"),
                    "machine_count": 0,
                    "paused_count": 0,
                    "stale_count": 0,
                    "jobs": [],
                }
                printers_by_key[printer_key] = printer

            printer["machine_count"] += 1
            if queue.get("queue_paused"):
                printer["paused_count"] += 1
            if is_machine_stale(
                machine.get("last_seen_at", ""), stale_after_minutes
            ):
                printer["stale_count"] += 1

            for job in queue.get("jobs", []):
                printer["jobs"].append(
                    {
                        **job,
                        "machine_id": machine.get("machine_id"),
                        "machine_name": machine.get("machine_name"),
                        "machine_location": machine.get("location"),
                        "machine_last_seen_at": machine.get("last_seen_at"),
                    }
                )

    printers = list(printers_by_key.values())
    for printer in printers:
        printer["jobs"].sort(
            key=lambda job: (
                parse_timestamp(job.get("submitted_at", "")) or datetime.min.replace(tzinfo=timezone.utc),
                job.get("machine_name", ""),
            )
        )

    printers.sort(key=lambda printer: printer["printer_name"].lower())
    return printers


def html_page(title: str, body: str, refresh_seconds: int) -> bytes:
    document = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="{refresh_seconds}">
  <title>{html.escape(title)}</title>
  <style>
    :root {{
      color-scheme: dark;
      --bg: #0f1720;
      --panel: #162331;
      --panel-2: #1b2b3c;
      --line: #294055;
      --text: #e8f0f7;
      --muted: #9fb2c4;
      --good: #84d8a2;
      --warn: #efc178;
      --bad: #f2a2a2;
      --accent: #78c6ef;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background: radial-gradient(circle at top, #17304a, var(--bg) 45%);
      color: var(--text);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }}
    main {{
      max-width: 1180px;
      margin: 0 auto;
      padding: 20px;
    }}
    h1, h2, h3, p {{ margin: 0; }}
    .hero, .card, .banner {{
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(22, 35, 49, 0.92);
      backdrop-filter: blur(8px);
    }}
    .hero {{
      padding: 18px;
      margin-bottom: 16px;
    }}
    .eyebrow {{
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--accent);
      font-size: 12px;
      margin-bottom: 8px;
    }}
    .hero-grid, .stats, .printer-grid, .machine-grid {{
      display: grid;
      gap: 12px;
    }}
    .hero-grid {{
      grid-template-columns: 1.8fr 1fr;
      align-items: start;
    }}
    .stats {{
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }}
    .stat {{
      padding: 12px;
      border-radius: 10px;
      background: var(--panel-2);
      border: 1px solid var(--line);
      text-align: center;
    }}
    .metric {{
      display: block;
      font-size: 28px;
      font-weight: 700;
    }}
    .label {{
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-size: 11px;
    }}
    .banner {{
      padding: 12px 14px;
      margin-bottom: 16px;
      color: var(--muted);
    }}
    .machine-grid, .printer-grid {{
      margin-bottom: 16px;
    }}
    .machine-grid {{
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    }}
    .printer-grid {{
      grid-template-columns: 1fr;
    }}
    .card {{
      padding: 14px;
    }}
    .card-header {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }}
    .muted {{
      color: var(--muted);
    }}
    .pill {{
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 88px;
      padding: 4px 9px;
      border-radius: 999px;
      border: 1px solid transparent;
      font-size: 12px;
      font-weight: 700;
    }}
    .pill.online {{ color: var(--good); background: rgba(28, 69, 43, 0.7); border-color: #2f6a49; }}
    .pill.stale, .pill.paused {{ color: var(--warn); background: rgba(74, 53, 22, 0.7); border-color: #7c5828; }}
    .pill.error {{ color: var(--bad); background: rgba(81, 29, 29, 0.7); border-color: #924141; }}
    .pill.mixed {{ color: #c3b4f2; background: rgba(47, 34, 82, 0.7); border-color: #6952a6; }}
    table {{
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
    }}
    th, td {{
      text-align: left;
      padding: 9px 8px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }}
    th {{
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-size: 11px;
    }}
    tr:last-child td {{ border-bottom: none; }}
    code {{
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: #d4e7f8;
    }}
    @media (max-width: 900px) {{
      .hero-grid {{
        grid-template-columns: 1fr;
      }}
      .stats {{
        grid-template-columns: 1fr;
      }}
    }}
  </style>
</head>
<body>
  <main>{body}</main>
</body>
</html>
"""
    return document.encode("utf-8")


@dataclass
class PublisherState:
    enabled: bool
    last_publish_at: str | None = None
    last_error: str | None = None
    last_snapshot_path: str | None = None
    current_snapshot: dict[str, Any] | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def update_success(self, snapshot: dict[str, Any], snapshot_path: Path) -> None:
        with self.lock:
            self.current_snapshot = snapshot
            self.last_snapshot_path = str(snapshot_path)
            self.last_publish_at = snapshot["last_seen_at"]
            self.last_error = None

    def update_error(self, message: str) -> None:
        with self.lock:
            self.last_error = message

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "enabled": self.enabled,
                "last_publish_at": self.last_publish_at,
                "last_error": self.last_error,
                "last_snapshot_path": self.last_snapshot_path,
                "current_snapshot": self.current_snapshot,
            }


def build_dashboard_body(
    args: argparse.Namespace,
    aggregate: dict[str, Any],
    publisher_state: PublisherState,
) -> str:
    machines = aggregate["machines"]
    printers = summarize_printers(machines, args.stale_after_minutes)
    machine_count = len(machines)
    printer_count = len(printers)
    job_count = sum(len(printer["jobs"]) for printer in printers)
    publisher = publisher_state.snapshot()

    machine_cards = []
    for machine in machines:
        stale = is_machine_stale(
            machine.get("last_seen_at", ""), args.stale_after_minutes
        )
        queue_count = len(machine.get("queues", []))
        job_total = sum(
            len(queue.get("jobs", [])) for queue in machine.get("queues", [])
        )
        status_class = "stale" if stale else "online"
        status_label = "Stale" if stale else "Online"
        machine_cards.append(
            f"""
            <section class="card">
              <div class="card-header">
                <div>
                  <h3>{html.escape(machine.get("machine_name", "Unknown"))}</h3>
                  <p class="muted">{html.escape(machine.get("location", "Unknown"))}</p>
                </div>
                <span class="pill {status_class}">{status_label}</span>
              </div>
              <p class="muted">{queue_count} queues, {job_total} jobs</p>
              <p class="muted">Last seen {html.escape(format_relative_age(machine.get("last_seen_at", "")))}</p>
            </section>
            """
        )

    printer_cards = []
    for printer in printers:
        if printer["paused_count"] == 0:
            queue_state = ("online", "Running")
        elif printer["paused_count"] == printer["machine_count"]:
            queue_state = ("paused", "Paused")
        else:
            queue_state = ("mixed", "Mixed")

        rows = []
        for job in printer["jobs"]:
            paper_markup = (
                f'<br><span class="muted">{html.escape(str(job.get("paper_name")))}</span>'
                if job.get("paper_name")
                else ""
            )
            rows.append(
                f"""
                <tr>
                  <td>
                    <strong>{html.escape(str(job.get("file_name", "Unknown job")))}</strong><br>
                    <span class="muted">Queue position {html.escape(str(job.get("position", "?")))}</span>
                    {paper_markup}
                  </td>
                  <td>{html.escape(str(job.get("status", "unknown")))}</td>
                  <td>{html.escape(str(job.get("source", "Mirage")))}</td>
                  <td>{html.escape(str(job.get("machine_name", "Unknown")))}</td>
                  <td>{html.escape(format_relative_age(str(job.get("submitted_at", ""))))}</td>
                </tr>
                """
            )

        if not rows:
            rows.append(
                """
                <tr>
                  <td colspan="5" class="muted">Queue is empty.</td>
                </tr>
                """
            )

        printer_cards.append(
            f"""
            <section class="card">
              <div class="card-header">
                <div>
                  <h2>{html.escape(printer["printer_name"])}</h2>
                  <p class="muted">{printer["machine_count"]} computers reporting</p>
                </div>
                <span class="pill {queue_state[0]}">{queue_state[1]}</span>
              </div>
              <p class="muted">Sources online {printer["machine_count"] - printer["stale_count"]}/{printer["machine_count"]}</p>
              <table>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Status</th>
                    <th>Source</th>
                    <th>Computer</th>
                    <th>Age</th>
                  </tr>
                </thead>
                <tbody>
                  {''.join(rows)}
                </tbody>
              </table>
            </section>
            """
        )

    publisher_banner = (
        f"Publishing enabled. Last write {html.escape(format_relative_age(publisher['last_publish_at']))}. "
        f"Snapshot file <code>{html.escape(publisher['last_snapshot_path'] or '')}</code>."
        if publisher["enabled"] and publisher["last_publish_at"]
        else "Publishing enabled. Waiting for first successful write."
        if publisher["enabled"]
        else "Dashboard-only mode. This instance is not publishing a local snapshot."
    )
    if publisher["last_error"]:
        publisher_banner += f" Current publisher error: {html.escape(publisher['last_error'])}."

    machines_markup = (
        "".join(machine_cards)
        if machine_cards
        else '<section class="card"><p class="muted">No workstation snapshots found in the shared folder yet.</p></section>'
    )
    printers_markup = (
        "".join(printer_cards)
        if printer_cards
        else '<section class="card"><p class="muted">No printer queues found yet.</p></section>'
    )

    return f"""
      <header class="hero">
        <div class="hero-grid">
          <div>
            <p class="eyebrow">QueueMaster</p>
            <h1>Mirage Queue Dashboard</h1>
            <p class="muted">Shared folder: <code>{html.escape(str(Path(args.shared_dir).expanduser()))}</code></p>
            <p class="muted">This page refreshes every {args.refresh_seconds} seconds.</p>
          </div>
          <div class="stats">
            <section class="stat">
              <span class="metric">{machine_count}</span>
              <span class="label">Machines</span>
            </section>
            <section class="stat">
              <span class="metric">{printer_count}</span>
              <span class="label">Printers</span>
            </section>
            <section class="stat">
              <span class="metric">{job_count}</span>
              <span class="label">Jobs</span>
            </section>
          </div>
        </div>
      </header>
      <section class="banner">
        <p>{publisher_banner}</p>
        <p>Aggregate generated {html.escape(format_relative_age(aggregate['generated_at']))}. API endpoint: <code>/api/snapshot</code></p>
      </section>
      <section class="machine-grid">
        {machines_markup}
      </section>
      <section class="printer-grid">
        {printers_markup}
      </section>
    """


def make_handler(
    args: argparse.Namespace, shared_dir: Path, publisher_state: PublisherState
) -> type[BaseHTTPRequestHandler]:
    class QueueMasterHandler(BaseHTTPRequestHandler):
        def _send_snapshot_json(self, include_body: bool) -> None:
            aggregate = build_aggregate_snapshot(shared_dir)
            payload = json.dumps(aggregate, ensure_ascii=False, indent=2).encode(
                "utf-8"
            )
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            if include_body:
                self.wfile.write(payload)

        def _send_dashboard_html(self, include_body: bool) -> None:
            aggregate = build_aggregate_snapshot(shared_dir)
            payload = html_page(
                "QueueMaster Dashboard",
                build_dashboard_body(args, aggregate, publisher_state),
                args.refresh_seconds,
            )
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            if include_body:
                self.wfile.write(payload)

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == "/api/snapshot":
                self._send_snapshot_json(include_body=True)
                return

            if parsed.path not in ("/", "/index.html"):
                self.send_error(HTTPStatus.NOT_FOUND, "Not found")
                return

            self._send_dashboard_html(include_body=True)

        def do_HEAD(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == "/api/snapshot":
                self._send_snapshot_json(include_body=False)
                return

            if parsed.path not in ("/", "/index.html"):
                self.send_error(HTTPStatus.NOT_FOUND, "Not found")
                return

            self._send_dashboard_html(include_body=False)

        def log_message(self, format: str, *values: Any) -> None:
            sys.stdout.write(
                "%s - - [%s] %s\n"
                % (
                    self.address_string(),
                    self.log_date_time_string(),
                    format % values,
                )
            )

    return QueueMasterHandler


def publisher_loop(
    args: argparse.Namespace,
    shared_dir: Path,
    publisher_state: PublisherState,
    stop_event: threading.Event,
) -> None:
    while not stop_event.is_set():
        try:
            snapshot = build_local_snapshot(args)
            snapshot_path = write_snapshot(shared_dir, snapshot)
            publisher_state.update_success(snapshot, snapshot_path)
            print(
                "[%s] Wrote snapshot for %s to %s"
                % (
                    utc_now_iso(),
                    snapshot["machine_name"],
                    snapshot_path,
                ),
                flush=True,
            )
        except Exception as error:
            publisher_state.update_error(str(error))
            print(
                "[%s] Publisher cycle failed: %s" % (utc_now_iso(), error),
                file=sys.stderr,
                flush=True,
            )

        if stop_event.wait(args.poll_interval_seconds):
            break


def serve_dashboard(
    args: argparse.Namespace, shared_dir: Path, publisher_state: PublisherState
) -> None:
    handler_class = make_handler(args, shared_dir, publisher_state)
    server = ThreadingHTTPServer(
        (args.dashboard_host, args.dashboard_port), handler_class
    )
    print(
        "Dashboard listening on http://%s:%s"
        % (args.dashboard_host, args.dashboard_port),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main() -> int:
    args = parse_args()
    shared_dir = resolve_shared_dir(args)
    args.shared_dir = str(shared_dir)
    publisher_enabled = args.mode in ("all", "publish")
    dashboard_enabled = args.mode in ("all", "dashboard")
    publisher_state = PublisherState(enabled=publisher_enabled)
    stop_event = threading.Event()
    publisher_thread: threading.Thread | None = None

    if publisher_enabled:
        publisher_thread = threading.Thread(
            target=publisher_loop,
            args=(args, shared_dir, publisher_state, stop_event),
            name="publisher",
            daemon=True,
        )
        publisher_thread.start()

    try:
        if dashboard_enabled:
            serve_dashboard(args, shared_dir, publisher_state)
        else:
            print(
                "Publisher mode active. Writing snapshots into %s every %ss."
                % (shared_dir, args.poll_interval_seconds),
                flush=True,
            )
            while True:
                time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        if publisher_thread is not None:
            publisher_thread.join(timeout=2)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
