// Runs the installed `pyric` command with these arguments, as a user would
// from the project directory, and exits with its exit code.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cliDir = join(process.cwd(), "node_modules/@pyric/cli");
const { bin } = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
const result = spawnSync(process.execPath, [join(cliDir, bin.pyric), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
