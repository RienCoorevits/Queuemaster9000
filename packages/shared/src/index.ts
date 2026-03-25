export type JobStatus = "spooling" | "queued" | "printing" | "paused" | "error" | "done";

export interface QueueJob {
  jobId: string;
  fileName: string;
  owner: string;
  status: JobStatus;
  position: number;
  submittedAt: string;
}

export interface PrinterQueue {
  printerId: string;
  printerName: string;
  queuePaused: boolean;
  jobs: QueueJob[];
}

export interface AgentHeartbeat {
  machineId: string;
  machineName: string;
  location: string;
  lastSeenAt: string;
  appVersion: string;
  queues: PrinterQueue[];
}

export interface MachineSnapshot {
  machineId: string;
  machineName: string;
  location: string;
  lastSeenAt: string;
  queues: PrinterQueue[];
}

export interface DashboardSnapshot {
  generatedAt: string;
  machines: MachineSnapshot[];
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

export function createMockHeartbeat(machineId: string): AgentHeartbeat {
  const machineNumber = machineId.endsWith("02") ? "02" : "01";

  return {
    machineId,
    machineName: `Mac Studio ${machineNumber}`,
    location: machineNumber === "01" ? "Studio A" : "Studio B",
    lastSeenAt: new Date().toISOString(),
    appVersion: "0.1.0",
    queues: [
      {
        printerId: `printer-${machineNumber}-a`,
        printerName: machineNumber === "01" ? "Epson P9000" : "Canon PRO-4100",
        queuePaused: false,
        jobs: [
          {
            jobId: `${machineId}-job-1`,
            fileName: "poster-hero.tif",
            owner: "rien",
            status: "printing",
            position: 1,
            submittedAt: minutesAgo(4)
          },
          {
            jobId: `${machineId}-job-2`,
            fileName: "gallery-wrap.pdf",
            owner: "studio",
            status: "queued",
            position: 2,
            submittedAt: minutesAgo(12)
          }
        ]
      },
      {
        printerId: `printer-${machineNumber}-b`,
        printerName: machineNumber === "01" ? "Epson P7500" : "Epson P5300",
        queuePaused: machineNumber === "02",
        jobs: machineNumber === "02"
          ? [
              {
                jobId: `${machineId}-job-3`,
                fileName: "proof-sheet-03.pdf",
                owner: "prepress",
                status: "paused",
                position: 1,
                submittedAt: minutesAgo(20)
              }
            ]
          : []
      }
    ]
  };
}

export function heartbeatToMachineSnapshot(heartbeat: AgentHeartbeat): MachineSnapshot {
  return {
    machineId: heartbeat.machineId,
    machineName: heartbeat.machineName,
    location: heartbeat.location,
    lastSeenAt: heartbeat.lastSeenAt,
    queues: heartbeat.queues
  };
}

export function createMockSnapshot(): DashboardSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    machines: [
      heartbeatToMachineSnapshot(createMockHeartbeat("mac-studio-01")),
      heartbeatToMachineSnapshot(createMockHeartbeat("mac-studio-02"))
    ]
  };
}

export function formatRelativeAge(timestamp: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 1000));

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function isMachineStale(lastSeenAt: string, staleAfterMinutes = 2): boolean {
  return Date.now() - new Date(lastSeenAt).getTime() > staleAfterMinutes * 60_000;
}
