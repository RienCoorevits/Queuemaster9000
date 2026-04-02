import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import {
  type AgentHeartbeat,
  type PrinterQueue,
  type QueueJob
} from "@queuemaster/shared";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  parseTagValue: true,
  parseAttributeValue: true
});

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  "Library",
  "Preferences",
  "de.dinax.mirage.config"
);

interface MiragePrinter {
  id: string;
  index: number;
  name: string;
  type: string;
  enabled: boolean;
  address?: string;
  uuid?: string;
}

interface MirageConfig {
  configPath: string;
  queueDirectoryPath: string;
  printers: MiragePrinter[];
}

interface JobCandidate {
  directoryPath: string;
  sortKey: number;
  metadata: Map<string, string>;
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (!value) {
    return fallback;
  }

  return value.trim().toLowerCase() === "true";
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseScalarValue(value: string): string {
  return value.trim();
}

function collectLeafValues(input: unknown, prefix = "", output = new Map<string, string>()) {
  if (input === null || input === undefined) {
    return output;
  }

  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean") {
    const value = String(input).trim();
    if (value) {
      output.set(prefix, value);
    }
    return output;
  }

  if (Array.isArray(input)) {
    input.forEach((item, index) => {
      collectLeafValues(item, `${prefix}.${index}`, output);
    });
    return output;
  }

  if (typeof input === "object") {
    for (const [key, value] of Object.entries(input)) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      collectLeafValues(value, nextPrefix, output);
    }
  }

  return output;
}

function firstMatchingValue(metadata: Map<string, string>, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeKey(candidate);

    for (const [key, value] of metadata.entries()) {
      if (normalizeKey(key).endsWith(normalizedCandidate)) {
        return value;
      }
    }
  }

  return undefined;
}

function matchingValues(metadata: Map<string, string>, candidate: string): string[] {
  const normalizedCandidate = normalizeKey(candidate);
  const values: string[] = [];

  for (const [key, value] of metadata.entries()) {
    if (!normalizeKey(key).endsWith(normalizedCandidate)) {
      continue;
    }

    const parsed = parseScalarValue(value);
    if (parsed) {
      values.push(parsed);
    }
  }

  return values;
}

function collectMatchingValues(metadata: Map<string, string>, candidates: string[]): string[] {
  const values: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    for (const value of matchingValues(metadata, candidate)) {
      const normalizedValue = value.trim().toLowerCase();
      if (seen.has(normalizedValue)) {
        continue;
      }

      seen.add(normalizedValue);
      values.push(value);
    }
  }

  return values;
}

function normalizeTimestamp(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }

  return parsed.toISOString();
}

function classifyStatusSignal(rawValue: string): { status: QueueJob["status"]; weight: number } | undefined {
  const value = rawValue.trim().toLowerCase();
  if (!value) {
    return undefined;
  }

  if (value.includes("error") || value.includes("warn") || value.includes("fail")) {
    return { status: "error", weight: 100 };
  }
  if (value.includes("pause") || value.includes("hold")) {
    return { status: "paused", weight: 90 };
  }
  if (
    value.includes("print") ||
    value.includes("render") ||
    value.includes("raster") ||
    value.includes("run") ||
    value.includes("process")
  ) {
    return { status: "printing", weight: 80 };
  }
  if (value.includes("spool") || value.includes("rip")) {
    return { status: "spooling", weight: 70 };
  }
  if (value.includes("done") || value.includes("complete") || value.includes("finished")) {
    return { status: "done", weight: 60 };
  }
  if (value.includes("queue") || value.includes("wait") || value.includes("pending")) {
    return { status: "queued", weight: 50 };
  }

  // Boolean-like values are weak signals and should not override richer status strings.
  if (value === "true") {
    return { status: "spooling", weight: 5 };
  }
  if (value === "false" || value === "0") {
    return { status: "queued", weight: 1 };
  }

  return undefined;
}

function normalizeStatus(rawStatuses: string[]): { status: QueueJob["status"]; rawStatus?: string } {
  if (rawStatuses.length === 0) {
    return { status: "queued" };
  }

  let bestStatus: QueueJob["status"] = "queued";
  let bestWeight = -1;
  for (const rawStatus of rawStatuses) {
    const classified = classifyStatusSignal(rawStatus);
    if (!classified) {
      continue;
    }

    if (classified.weight > bestWeight) {
      bestStatus = classified.status;
      bestWeight = classified.weight;
    }
  }

  const rawStatus =
    rawStatuses.length > 3 ? `${rawStatuses.slice(0, 3).join(" | ")} ...` : rawStatuses.join(" | ");
  return { status: bestStatus, rawStatus };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function loadConfig(configPath: string): Promise<MirageConfig> {
  const configText = await fs.readFile(configPath, "utf8");
  const entries = new Map<string, string>();

  for (const line of configText.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key) {
      entries.set(key, value);
    }
  }

  const printerIndexes = new Set<number>();
  for (const key of entries.keys()) {
    const match = /^printers\.(\d+)\./.exec(key);
    if (match) {
      printerIndexes.add(Number(match[1]));
    }
  }

  const printers = [...printerIndexes]
    .sort((left, right) => left - right)
    .map((index) => {
      const name = entries.get(`printers.${index}.desc`) ?? `Printer ${index + 1}`;
      return {
        id: entries.get(`printers.${index}.uuid`) ?? `printer-${index}`,
        index,
        name,
        type: entries.get(`printers.${index}.type`) ?? name,
        enabled: parseBoolean(entries.get(`printers.${index}.enabled`), true),
        address: entries.get(`printers.${index}.tcp.address`),
        uuid: entries.get(`printers.${index}.uuid`)
      };
    })
    .filter((printer) => printer.enabled);

  const queueDirectoryPath =
    entries.get("queue.directory.path") ??
    path.join(os.homedir(), "Library", "Application Support", "Mirage", "Mirage Queue");

  return {
    configPath,
    queueDirectoryPath,
    printers
  };
}

async function parseXmlFile(xmlPath: string): Promise<Map<string, string>> {
  const xmlText = await fs.readFile(xmlPath, "utf8");
  const parsed = xmlParser.parse(xmlText);
  return collectLeafValues(parsed);
}

async function parseKeyValueFile(filePath: string): Promise<Map<string, string>> {
  const text = await fs.readFile(filePath, "utf8");
  const values = new Map<string, string>();

  for (const line of text.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = parseScalarValue(line.slice(separatorIndex + 1));
    if (key && value) {
      values.set(key, value);
    }
  }

  return values;
}

async function parseMetadataFile(filePath: string): Promise<Map<string, string>> {
  if (filePath.endsWith(".xml")) {
    return parseXmlFile(filePath).catch(() => new Map<string, string>());
  }

  return parseKeyValueFile(filePath).catch(() => new Map<string, string>());
}

async function readJobCandidate(directoryPath: string): Promise<JobCandidate> {
  const stat = await fs.stat(directoryPath);
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const metadata = new Map<string, string>();
  const directFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const fileName of directFiles) {
    const filePath = path.join(directoryPath, fileName);
    const values = await parseMetadataFile(filePath);
    for (const [key, value] of values.entries()) {
      metadata.set(`${fileName}.${key}`, value);
      metadata.set(key, value);
    }
  }

  for (const entry of entries.filter((child) => child.isDirectory())) {
    const nestedDirectoryPath = path.join(directoryPath, entry.name);
    const nestedEntries = await fs.readdir(nestedDirectoryPath, { withFileTypes: true });
    for (const nestedEntry of nestedEntries) {
      if (!nestedEntry.isFile()) {
        continue;
      }

      const nestedPath = path.join(nestedDirectoryPath, nestedEntry.name);
      if (!nestedPath.endsWith(".xml")) {
        continue;
      }

      const values = await parseMetadataFile(nestedPath);
      for (const [key, value] of values.entries()) {
        metadata.set(`${entry.name}/${nestedEntry.name}.${key}`, value);
        metadata.set(`${nestedEntry.name}.${key}`, value);
        if (!metadata.has(key)) {
          metadata.set(key, value);
        }
      }
    }
  }

  return {
    directoryPath,
    sortKey: stat.mtimeMs,
    metadata
  };
}

function pickPrinterName(candidate: JobCandidate, printers: MiragePrinter[]): string | undefined {
  const printerName = firstMatchingValue(candidate.metadata, [
    "jobInfo.printerName",
    "printerName"
  ]);

  if (!printerName) {
    return undefined;
  }

  const matchedPrinter = printers.find(
    (printer) =>
      printer.name.toLowerCase() === printerName.toLowerCase() ||
      printer.type.toLowerCase() === printerName.toLowerCase()
  );

  return matchedPrinter?.name ?? printerName;
}

function toQueueJob(candidate: JobCandidate, position: number): QueueJob {
  const fallbackTimestamp = new Date(candidate.sortKey).toISOString();
  const rawStatuses = collectMatchingValues(candidate.metadata, [
    "consumer.progress.pagePhase",
    "consumer.progress.status",
    "status",
    "jobStatus",
    "jobInfo.jobStatus",
    "state",
    "producer.active"
  ]);
  const normalizedStatus = normalizeStatus(rawStatuses);
  const pageDescription = firstMatchingValue(candidate.metadata, [
    "pageDescription.0",
    "pageDescription"
  ]);
  const jobTitle = firstMatchingValue(candidate.metadata, ["jobInfo.jobTitle", "jobTitle", "title"]);
  const fileName =
    jobTitle ||
    pageDescription?.split(" - Page ")[0]?.split("/").pop() ||
    path.basename(candidate.directoryPath);

  return {
    jobId:
      firstMatchingValue(candidate.metadata, [
        "jobInfo.jobUniqueID",
        "jobID",
        "jobId",
        "ID.jobID"
      ]) ??
      path.basename(candidate.directoryPath),
    fileName,
    source:
      firstMatchingValue(candidate.metadata, ["jobInfo.applicationName", "applicationName"]) ??
      "Mirage",
    status: normalizedStatus.status,
    position,
    submittedAt: normalizeTimestamp(
      firstMatchingValue(candidate.metadata, ["jobInfo.printDate", "printDate"]),
      fallbackTimestamp
    ),
    paperName: firstMatchingValue(candidate.metadata, [
      "jobInfo.paperName",
      "paperName",
      "printerSettings.mediaType",
      "mediaType"
    ]),
    sourcePath: candidate.directoryPath,
    rawStatus: normalizedStatus.rawStatus
  };
}

async function scanQueueDirectory(queueDirectoryPath: string, printers: MiragePrinter[]): Promise<PrinterQueue[]> {
  const queues = new Map(
    printers.map((printer) => [
      printer.name,
      {
        printerId: printer.id,
        printerName: printer.name,
        queuePaused: false,
        jobs: [] as QueueJob[]
      }
    ])
  );

  if (!(await pathExists(queueDirectoryPath))) {
    return [...queues.values()];
  }

  const entries = await fs.readdir(queueDirectoryPath, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== "_archive")
      .map((entry) => readJobCandidate(path.join(queueDirectoryPath, entry.name)))
  );

  const sortedCandidates = candidates.sort((left, right) => left.sortKey - right.sortKey);

  for (const candidate of sortedCandidates) {
    const printerName = pickPrinterName(candidate, printers);
    const queue =
      (printerName ? queues.get(printerName) : undefined) ??
      [...queues.values()][0] ??
      {
        printerId: "unassigned",
        printerName: "Unassigned",
        queuePaused: false,
        jobs: []
      };

    if (!queues.has(queue.printerName)) {
      queues.set(queue.printerName, queue);
    }

    queue.jobs.push(toQueueJob(candidate, queue.jobs.length + 1));
  }

  return [...queues.values()];
}

export async function buildMirageHeartbeat(options: {
  configPath?: string;
  queuePath?: string;
  machineId?: string;
  machineName?: string;
  location?: string;
} = {}): Promise<AgentHeartbeat> {
  const config = await loadConfig(options.configPath ?? DEFAULT_CONFIG_PATH);
  const queueDirectoryPath = options.queuePath ?? config.queueDirectoryPath;
  const queues = await scanQueueDirectory(queueDirectoryPath, config.printers);

  return {
    machineId: options.machineId ?? os.hostname(),
    machineName: options.machineName ?? os.hostname(),
    location: options.location ?? "Unknown",
    lastSeenAt: new Date().toISOString(),
    appVersion: "0.2.0",
    queues
  };
}

export function getDefaultMirageConfigPath() {
  return DEFAULT_CONFIG_PATH;
}
