import { spawn } from "node:child_process";
import { bundleCli } from "./bundle-cli.ts";

// `vp run serve` has already run `vp build`; this bundles the CLI and runs it with plain node.
const cli = await bundleCli();
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.once("exit", (code) => process.exit(code ?? 1));
