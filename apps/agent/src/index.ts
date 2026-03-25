import { type AgentHeartbeat } from "@queuemaster/shared";
import {
  buildMirageHeartbeat,
  getDefaultMirageConfigPath
} from "./mirage.js";

const apiBaseUrl = process.env.API_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:8787";
const machineId = process.env.MACHINE_ID;
const machineName = process.env.MACHINE_NAME;
const location = process.env.LOCATION;
const dryRun = process.argv.includes("--dry-run");
const runOnce = process.argv.includes("--once");
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? "10000");

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sendHeartbeat(heartbeat: AgentHeartbeat) {
  const response = await fetch(`${apiBaseUrl}/api/heartbeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(heartbeat)
  });

  if (!response.ok) {
    throw new Error(`Heartbeat failed with status ${response.status}`);
  }
}

async function buildHeartbeat() {
  return buildMirageHeartbeat({
    configPath: process.env.MIRAGE_CONFIG_PATH ?? getDefaultMirageConfigPath(),
    queuePath: process.env.MIRAGE_QUEUE_PATH,
    machineId,
    machineName,
    location
  });
}

function logHeartbeat(heartbeat: AgentHeartbeat) {
  const jobCount = heartbeat.queues.reduce((sum, queue) => sum + queue.jobs.length, 0);
  console.log(
    `[${new Date().toISOString()}] Sent heartbeat for ${heartbeat.machineName} ` +
      `(${heartbeat.queues.length} queues, ${jobCount} jobs) to ${apiBaseUrl}`
  );
}

async function runCycle() {
  const heartbeat = await buildHeartbeat();

  if (dryRun) {
    console.log(JSON.stringify(heartbeat, null, 2));
    return;
  }

  await sendHeartbeat(heartbeat);
  logHeartbeat(heartbeat);
}

async function main() {
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(`Invalid POLL_INTERVAL_MS value: ${pollIntervalMs}`);
  }

  if (dryRun || runOnce) {
    await runCycle();
    return;
  }

  console.log(`Queue agent polling every ${pollIntervalMs}ms and posting to ${apiBaseUrl}`);

  while (true) {
    try {
      await runCycle();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Agent cycle failed: ${message}`);
    }

    await sleep(pollIntervalMs);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Agent failed: ${message}`);
  process.exit(1);
});
