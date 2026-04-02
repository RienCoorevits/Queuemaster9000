import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(desktopRoot, "..", "..");
const outdir = path.join(desktopRoot, "runtime");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: [path.join(workspaceRoot, "apps/agent/src/index.ts")],
  outfile: path.join(outdir, "agent.mjs"),
  bundle: true,
  splitting: false,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "bundle",
  sourcemap: false,
  minify: false
});

await build({
  entryPoints: [path.join(workspaceRoot, "apps/server/src/index.ts")],
  outfile: path.join(outdir, "server.mjs"),
  bundle: true,
  splitting: false,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "bundle",
  sourcemap: false,
  minify: false
});

console.log(`Built desktop runtime bundles in ${outdir}`);
