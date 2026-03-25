import { useEffect, useMemo, useState } from "react";
import {
  type DashboardSnapshot,
  createMockSnapshot,
  formatRelativeAge,
  isMachineStale
} from "@queuemaster/shared";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";

async function loadSnapshot(): Promise<DashboardSnapshot> {
  if (!apiBaseUrl) {
    return createMockSnapshot();
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

  useEffect(() => {
    let cancelled = false;

    loadSnapshot()
      .then((data) => {
        if (!cancelled) {
          setSnapshot(data);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Unknown error");
          setSnapshot(createMockSnapshot());
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const totals = useMemo(() => {
    if (!snapshot) {
      return { machines: 0, printers: 0, jobs: 0 };
    }

    return snapshot.machines.reduce(
      (accumulator, machine) => {
        accumulator.machines += 1;
        accumulator.printers += machine.queues.length;
        accumulator.jobs += machine.queues.reduce((sum, queue) => sum + queue.jobs.length, 0);
        return accumulator;
      },
      { machines: 0, printers: 0, jobs: 0 }
    );
  }, [snapshot]);

  return (
    <main className="page-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">QueueMaster9000</p>
          <h1>Mirage queue visibility across all print stations</h1>
          <p className="hero-copy">
            Static dashboard for GitHub Pages, backed by a separate ingest API when ready.
          </p>
        </div>
        <div className="status-card">
          <div>
            <span className="metric">{totals.machines}</span>
            <span className="label">Machines</span>
          </div>
          <div>
            <span className="metric">{totals.printers}</span>
            <span className="label">Queues</span>
          </div>
          <div>
            <span className="metric">{totals.jobs}</span>
            <span className="label">Jobs</span>
          </div>
        </div>
      </header>

      <section className="banner-row">
        <div className="banner">
          Source: {apiBaseUrl ? `API ${apiBaseUrl}` : "mock snapshot"}.
        </div>
        {error ? <div className="banner error">API fallback: {error}</div> : null}
      </section>

      <section className="machine-grid">
        {snapshot?.machines.map((machine) => (
          <article key={machine.machineId} className="machine-card">
            <div className="machine-header">
              <div>
                <h2>{machine.machineName}</h2>
                <p>{machine.location}</p>
              </div>
              <span className={isMachineStale(machine.lastSeenAt) ? "pill stale" : "pill online"}>
                {isMachineStale(machine.lastSeenAt) ? "Stale" : "Online"}
              </span>
            </div>
            <p className="last-seen">Last heartbeat {formatRelativeAge(machine.lastSeenAt)}</p>

            {machine.queues.map((queue) => (
              <div key={queue.printerId} className="queue-card">
                <div className="queue-header">
                  <div>
                    <h3>{queue.printerName}</h3>
                    <p>{queue.jobs.length} queued jobs</p>
                  </div>
                  <span className={`pill ${queue.queuePaused ? "paused" : "online"}`}>
                    {queue.queuePaused ? "Paused" : "Running"}
                  </span>
                </div>

                <table>
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th>Status</th>
                      <th>Owner</th>
                      <th>Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queue.jobs.map((job) => (
                      <tr key={job.jobId}>
                        <td>
                          <strong>{job.fileName}</strong>
                          <div className="subtle">Position {job.position}</div>
                        </td>
                        <td>{job.status}</td>
                        <td>{job.owner}</td>
                        <td>{formatRelativeAge(job.submittedAt)}</td>
                      </tr>
                    ))}
                    {queue.jobs.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="empty-state">
                          Queue is empty.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            ))}
          </article>
        ))}
      </section>
    </main>
  );
}
