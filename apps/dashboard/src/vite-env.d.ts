/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_REFRESH_INTERVAL_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  queuemasterDesktop?: {
    getConfig: () => {
      apiBaseUrl?: string;
    };
    windows?: {
      openServices: () => Promise<void>;
    };
    services?: {
      getStatus: () => Promise<{
        agent: DesktopServiceStatus;
        server: DesktopServiceStatus;
      }>;
      installAgent: (options: {
        apiBaseUrl?: string;
        pollIntervalMs?: number;
      }) => Promise<DesktopServiceStatus>;
      installServer: (options: {
        port?: number;
      }) => Promise<DesktopServiceStatus>;
      uninstallAgent: () => Promise<DesktopServiceStatus>;
      uninstallServer: () => Promise<DesktopServiceStatus>;
    };
  };
}

interface DesktopServiceStatus {
  label: string;
  installed: boolean;
  running: boolean;
  plistPath: string;
  runtimeScriptPath: string;
  stdoutPath: string;
  stderrPath: string;
  recentStdout: string;
  recentStderr: string;
}
