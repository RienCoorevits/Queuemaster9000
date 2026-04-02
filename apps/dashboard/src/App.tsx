import { useEffect, useMemo, useState } from "react";
import {
  type DashboardSnapshot,
  formatRelativeAge,
  isMachineStale
} from "@queuemaster/shared";

const isServicesWindow = new URLSearchParams(window.location.search).get("window") === "services";
const runtimeApiBaseUrl = window.queuemasterDesktop?.getConfig().apiBaseUrl?.replace(/\/$/, "");
const configuredApiBaseUrl =
  runtimeApiBaseUrl ?? import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";
const apiBaseUrl = configuredApiBaseUrl || (import.meta.env.DEV ? "" : null);
const refreshIntervalMs = Number(import.meta.env.VITE_REFRESH_INTERVAL_MS ?? "5000");
const desktopWindows = window.queuemasterDesktop?.windows;
const desktopServices = window.queuemasterDesktop?.services;
const connectivityMessage = "Cannot reach server or agent not installed.";

type PrinterJobView = DashboardSnapshot["machines"][number]["queues"][number]["jobs"][number] & {
  machineId: string;
  machineName: string;
  machineLocation: string;
  machineLastSeenAt: string;
};

type PrinterView = {
  printerId: string;
  printerName: string;
  machineCount: number;
  pausedCount: number;
  staleCount: number;
  jobs: PrinterJobView[];
};

async function loadSnapshot(): Promise<DashboardSnapshot> {
  if (apiBaseUrl === null) {
    throw new Error(connectivityMessage);
  }

  const response = await fetch(`${apiBaseUrl}/api/queues`);
  if (!response.ok) {
    throw new Error(`Failed to load queues: ${response.status}`);
  }

  return (await response.json()) as DashboardSnapshot;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serviceStatus, setServiceStatus] = useState<{
    agent: DesktopServiceStatus;
    server: DesktopServiceStatus;
  } | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [agentApiBaseUrl, setAgentApiBaseUrl] = useState(
    apiBaseUrl === null ? "http://127.0.0.1:8787" : apiBaseUrl || "http://127.0.0.1:8787"
  );
  const [serverPort, setServerPort] = useState("8787");

  async function refreshServiceStatus() {
    if (!desktopServices) {
      return;
    }

    try {
      const nextStatus = await desktopServices.getStatus();
      setServiceStatus(nextStatus);
      setServiceError(null);
    } catch (reason: unknown) {
      setServiceError(reason instanceof Error ? reason.message : "Failed to load service status");
    }
  }

  async function runServiceAction(
    actionLabel: string,
    action: () => Promise<unknown>
  ) {
    setBusyAction(actionLabel);
    try {
      await action();
      await refreshServiceStatus();
    } catch (reason: unknown) {
      setServiceError(reason instanceof Error ? reason.message : "Service action failed");
    } finally {
      setBusyAction(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    let timerId: number | undefined;

    const refresh = async () => {
      try {
        const data = await loadSnapshot();
        if (!cancelled) {
          setSnapshot(data);
          setError(null);
        }
      } catch (reason: unknown) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : connectivityMessage);
          setSnapshot(null);
        }
      } finally {
        if (!cancelled && apiBaseUrl !== null) {
          timerId = window.setTimeout(refresh, refreshIntervalMs);
        }
      }
    };

    void refresh();

    return () => {
      cancelled = true;
      if (timerId) {
        window.clearTimeout(timerId);
      }
    };
  }, []);

  useEffect(() => {
    void refreshServiceStatus();
  }, []);

  const printerViews = useMemo(() => {
    if (!snapshot) {
      return [] as PrinterView[];
    }

    const printersById = new Map<string, PrinterView>();

    snapshot.machines.forEach((machine) => {
      machine.queues.forEach((queue) => {
        const printerKey = (queue.printerName || queue.printerId).trim().toLowerCase();
        let printer = printersById.get(printerKey);
        if (!printer) {
          printer = {
            printerId: queue.printerId,
            printerName: queue.printerName,
            machineCount: 0,
            pausedCount: 0,
            staleCount: 0,
            jobs: []
          };
          printersById.set(printerKey, printer);
        }

        printer.machineCount += 1;
        if (queue.queuePaused) {
          printer.pausedCount += 1;
        }
        if (isMachineStale(machine.lastSeenAt)) {
          printer.staleCount += 1;
        }

        queue.jobs.forEach((job) => {
          printer.jobs.push({
            ...job,
            machineId: machine.machineId,
            machineName: machine.machineName,
            machineLocation: machine.location,
            machineLastSeenAt: machine.lastSeenAt
          });
        });
      });
    });

    return Array.from(printersById.values())
      .map((printer) => ({
        ...printer,
        jobs: [...printer.jobs].sort((a, b) => {
          const timeDiff = new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime();
          if (timeDiff !== 0) {
            return timeDiff;
          }
          return a.machineName.localeCompare(b.machineName);
        })
      }))
      .sort((a, b) => a.printerName.localeCompare(b.printerName));
  }, [snapshot]);

  const totals = useMemo(() => {
    if (!snapshot) {
      return { machines: 0, printers: 0, jobs: 0 };
    }

    return {
      machines: snapshot.machines.length,
      printers: printerViews.length,
      jobs: printerViews.reduce((sum, printer) => sum + printer.jobs.length, 0)
    };
  }, [snapshot, printerViews]);

  const showConnectivityWarning =
    Boolean(error) ||
    Boolean(
      desktopServices &&
        serviceStatus &&
        (!serviceStatus.agent.running || !serviceStatus.server.running)
    );

  const installerSection =
    desktopServices ? (
      serviceStatus ? (
        <section className="installer-grid">
        <article className="installer-card">
          <div className="installer-header">
            <div>
              <h2>Local Agent</h2>
            </div>
            <span className={serviceStatus.agent.running ? "pill online" : "pill stale"}>
              {serviceStatus.agent.running ? "Running" : serviceStatus.agent.installed ? "Installed" : "Not installed"}
            </span>
          </div>
          <p className="hero-copy">
            Installs a launch agent that reads Mirage queue data on this machine and posts it to the selected server URL.
          </p>
          <label className="field">
            <span>Server URL</span>
            <input
              value={agentApiBaseUrl}
              onChange={(event) => setAgentApiBaseUrl(event.target.value)}
              placeholder="http://127.0.0.1:8787"
            />
          </label>
          <div className="button-row">
            <button
              onClick={() =>
                void runServiceAction("install-agent", () =>
                  desktopServices.installAgent({ apiBaseUrl: agentApiBaseUrl })
                )
              }
              disabled={busyAction !== null}
            >
              Install local agent
            </button>
            <button
              className="secondary"
              onClick={() => void runServiceAction("uninstall-agent", () => desktopServices.uninstallAgent())}
              disabled={busyAction !== null}
            >
              Remove
            </button>
            <button
              className="secondary"
              onClick={() => void refreshServiceStatus()}
              disabled={busyAction !== null}
            >
              Refresh
            </button>
          </div>
          <p className="subtle">LaunchAgent: {serviceStatus.agent.plistPath}</p>
          {serviceStatus.agent.recentStderr ? (
            <pre className="log-snippet">{serviceStatus.agent.recentStderr}</pre>
          ) : null}
        </article>

        <article className="installer-card">
          <div className="installer-header">
            <div>
              <h2>Local Server</h2>
            </div>
            <span className={serviceStatus.server.running ? "pill online" : "pill stale"}>
              {serviceStatus.server.running ? "Running" : serviceStatus.server.installed ? "Installed" : "Not installed"}
            </span>
          </div>
          <p className="hero-copy">
            Installs a launch agent that runs the local ingest API. Use this on the machine that should act as the LAN server.
          </p>
          <label className="field">
            <span>Port</span>
            <input
              value={serverPort}
              onChange={(event) => setServerPort(event.target.value)}
              placeholder="8787"
            />
          </label>
          <div className="button-row">
            <button
              onClick={() => {
                const parsedPort = Number(serverPort || "8787");
                if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
                  setServiceError("Server port must be a number between 1 and 65535.");
                  return;
                }

                void runServiceAction("install-server", () =>
                  desktopServices.installServer({ port: parsedPort })
                );
              }}
              disabled={busyAction !== null}
            >
              Install local server
            </button>
            <button
              className="secondary"
              onClick={() => void runServiceAction("uninstall-server", () => desktopServices.uninstallServer())}
              disabled={busyAction !== null}
            >
              Remove
            </button>
            <button
              className="secondary"
              onClick={() => void refreshServiceStatus()}
              disabled={busyAction !== null}
            >
              Refresh
            </button>
          </div>
          <p className="subtle">LaunchAgent: {serviceStatus.server.plistPath}</p>
          {serviceStatus.server.recentStderr ? (
            <pre className="log-snippet">{serviceStatus.server.recentStderr}</pre>
          ) : null}
        </article>
        </section>
      ) : (
        <section className="banner-row">
          <div className="banner">Loading local service status...</div>
        </section>
      )
    ) : (
      <section className="banner-row">
        <div className="banner error">Local services are only available in the desktop app.</div>
      </section>
    );

  if (isServicesWindow) {
    return (
      <main className="page-shell services-window-shell">
        <header className="hero">
          <div>
            <p className="eyebrow">QueueMaster9000</p>
            <h1>Local Services</h1>
          </div>
        </header>

        {serviceError ? (
          <section className="banner-row">
            <div className="banner error">Installer: {serviceError}</div>
          </section>
        ) : null}

        {installerSection}
      </main>
    );
  }

  return (
    <main className="page-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">QueueMaster9000</p>
          <h1>Mirage queue visibility across all print stations</h1>
          <p className="hero-copy">
            Desktop dashboard for Mirage queue visibility across the local network.
          </p>
        </div>
        <div className="header-tools">
          <div className="status-card">
            <div>
              <span className="metric">{totals.machines}</span>
              <span className="label">Machines</span>
            </div>
            <div>
              <span className="metric">{totals.printers}</span>
              <span className="label">Printers</span>
            </div>
            <div>
              <span className="metric">{totals.jobs}</span>
              <span className="label">Jobs</span>
            </div>
          </div>
          {desktopWindows ? (
            <button
              className="secondary services-launch-button"
              onClick={() => void desktopWindows.openServices()}
            >
              Services
            </button>
          ) : null}
        </div>
      </header>

      <section className="banner-row">
        <div className="banner">Source: {apiBaseUrl ?? "not configured"}.</div>
        {showConnectivityWarning ? (
          <div className="banner error">{connectivityMessage}</div>
        ) : null}
        {serviceError ? <div className="banner error">Installer: {serviceError}</div> : null}
      </section>

      <section className="machine-grid">
        {printerViews.map((printer) => {
          const queueState =
            printer.pausedCount === 0
              ? "running"
              : printer.pausedCount === printer.machineCount
                ? "paused"
                : "mixed";

          const sourcesOnline = printer.machineCount - printer.staleCount;

          return (
            <article key={printer.printerId} className="machine-card">
              <div className="machine-header">
                <div>
                  <h2>{printer.printerName}</h2>
                  <p>{printer.machineCount} computers reporting</p>
                </div>
                <span className={`pill ${queueState === "running" ? "online" : queueState}`}>
                  {queueState === "running" ? "Running" : queueState === "paused" ? "Paused" : "Mixed"}
                </span>
              </div>
              <p className="last-seen">
                Sources online {sourcesOnline}/{printer.machineCount}
              </p>

              <div className="queue-card">
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
                    {printer.jobs.map((job) => (
                      <tr key={`${job.machineId}:${job.jobId}`}>
                        <td>
                          <strong>{job.fileName}</strong>
                          <div className="subtle">Queue position {job.position}</div>
                          {job.paperName ? <div className="subtle">{job.paperName}</div> : null}
                        </td>
                        <td>{job.status}</td>
                        <td>{job.source}</td>
                        <td>{job.machineName}</td>
                        <td>{formatRelativeAge(job.submittedAt)}</td>
                      </tr>
                    ))}
                    {printer.jobs.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="empty-state">
                          Queue is empty.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </article>
          );
        })}
      </section>
    </main>
  );
}
