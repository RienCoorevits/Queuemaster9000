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

async function main() {
  const heartbeat = await buildMirageHeartbeat({
    configPath: process.env.MIRAGE_CONFIG_PATH ?? getDefaultMirageConfigPath(),
    queuePath: process.env.MIRAGE_QUEUE_PATH,
    machineId,
    machineName,
    location
  });

  if (dryRun) {
    console.log(JSON.stringify(heartbeat, null, 2));
    return;
  }

  await sendHeartbeat(heartbeat);
  console.log(`Heartbeat sent for ${heartbeat.machineName} to ${apiBaseUrl}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Agent failed: ${message}`);
  process.exit(1);
});
