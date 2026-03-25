import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const isGitHubPages = process.env.GITHUB_PAGES === "true";

export default defineConfig({
  plugins: [react()],
  base: isGitHubPages ? "/Queuemaster9000/" : "/",
  server: {
    proxy: {
      "/api": "http://localhost:8787"
    }
  }
});
