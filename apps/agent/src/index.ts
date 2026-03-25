import {
  createMockHeartbeat,
  type AgentHeartbeat
} from "@queuemaster/shared";

const apiBaseUrl = process.env.API_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:8787";
const machineId = process.env.MACHINE_ID ?? "mac-studio-01";

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
  const heartbeat = createMockHeartbeat(machineId);

  // Placeholder until we know how to reliably read Mirage queue state on macOS.
  await sendHeartbeat(heartbeat);
  console.log(`Heartbeat sent for ${heartbeat.machineName} to ${apiBaseUrl}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Agent failed: ${message}`);
  process.exit(1);
});
