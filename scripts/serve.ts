import { spawn } from "node:child_process";
import { constants } from "node:os";
import { bundleCli } from "./bundle-cli.ts";

// `vp run serve` has already run `vp build`; this bundles the CLI and runs it with plain node.
const cli = await bundleCli();
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit" });
// Forward signals sent to this process alone (e.g. `kill <pid>`). Ctrl-C also reaches the
// child directly; the CLI ignores the duplicate while it shuts down.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.once("exit", (code, signal) =>
  process.exit(code ?? (signal ? 128 + constants.signals[signal] : 1)),
);
