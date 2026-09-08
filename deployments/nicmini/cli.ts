import { parseArgs } from "../../src/args";
import { runHostCommand } from "./host";
try { await runHostCommand(parseArgs(["host", ...process.argv.slice(2)])); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
