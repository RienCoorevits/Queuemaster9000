import { createServer } from "node:http";
import {
  createMockSnapshot,
  type AgentHeartbeat,
  type DashboardSnapshot,
  heartbeatToMachineSnapshot
} from "@queuemaster/shared";

const port = Number(process.env.PORT ?? "8787");
let snapshot: DashboardSnapshot = createMockSnapshot();

function sendJson(response: import("node:http").ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json"
  });
  response.end(JSON.stringify(body));
}

const server = createServer((request, response) => {
  if (!request.url) {
    sendJson(response, 400, { error: "Missing URL" });
    return;
  }

  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  if (request.method === "GET" && request.url === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && request.url === "/api/queues") {
    sendJson(response, 200, snapshot);
    return;
  }

  if (request.method === "POST" && request.url === "/api/heartbeat") {
    const chunks: Buffer[] = [];

    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      try {
        const heartbeat = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AgentHeartbeat;
        const machineSnapshot = heartbeatToMachineSnapshot(heartbeat);
        const otherMachines = snapshot.machines.filter(
          (machine) => machine.machineId !== machineSnapshot.machineId
        );

        snapshot = {
          generatedAt: new Date().toISOString(),
          machines: [...otherMachines, machineSnapshot].sort((left, right) =>
            left.machineName.localeCompare(right.machineName)
          )
        };

        sendJson(response, 202, { ok: true });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Invalid JSON";
        sendJson(response, 400, { error: message });
      }
    });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
});

server.listen(port, () => {
  console.log(`Queue server listening on http://localhost:${port}`);
});
