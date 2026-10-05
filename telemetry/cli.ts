#!/usr/bin/env bun
import { buildEnvelopes } from "./aggregate.ts";
import { readSqliteSnapshots } from "./source.ts";
import { LocalState, pendingRecords } from "./state.ts";
import { hasCredentials } from "./transport.ts";

interface Options {
  sources: string[];
  state: string | undefined;
  enable: boolean;
  dryRun: boolean;
  sessionBudget: number | undefined;
  accountBudget: number | undefined;
}

function usage(): never {
  throw new Error("Usage: bun telemetry/cli.ts sync --source <opencode.db> [--state <path>] [--enable] [--dry-run] [--session-budget <n>] [--total-budget <n>]");
}

function nonnegative(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a nonnegative integer.`);
  return Number(value);
}

function parse(argv: string[]): Options {
  if (argv[0] !== "sync") usage();
  const options: Options = { sources: [], state: undefined, enable: false, dryRun: false, sessionBudget: undefined, accountBudget: undefined };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--enable") options.enable = true;
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--source" || flag === "--state" || flag === "--session-budget" || flag === "--total-budget") {
      const value = argv[++index];
      if (!value) throw new Error(`${flag} requires a value.`);
      if (flag === "--source") options.sources.push(value);
      else if (flag === "--state") options.state = value;
      else if (flag === "--session-budget") options.sessionBudget = nonnegative(value, flag);
      else options.accountBudget = nonnegative(value, flag);
    } else if (flag === "--help" || flag === "-h") usage();
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (options.sources.length === 0) throw new Error("--source is required.");
  return options;
}

export function run(argv: string[], env: Record<string, string | undefined> = process.env): number {
  let options: Options;
  try { options = parse(argv); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (!options.enable) {
    console.log(JSON.stringify({ enabled: false, queued: 0, reason: "opt_in_required" }));
    return 0;
  }
  if (!hasCredentials(env)) {
    console.error(JSON.stringify({ enabled: false, queued: 0, reason: "credentials_missing" }));
    return 2;
  }
  const snapshot = readSqliteSnapshots(options.sources);
  const payloads = buildEnvelopes(snapshot, { sessionBudget: options.sessionBudget, accountBudget: options.accountBudget });
  const records = pendingRecords(payloads);
  if (options.dryRun) {
    console.log(JSON.stringify({ enabled: true, dryRun: true, records: records.length, diagnostics: snapshot.diagnostics.map((item) => item.code) }));
    return snapshot.complete ? 0 : 1;
  }
  const state = new LocalState(options.state);
  const result = state.reconcile(records);
  console.log(JSON.stringify({ enabled: true, queued: result.added, unchanged: result.unchanged, pending: state.pending().length, malformedStateLines: result.malformed, diagnostics: snapshot.diagnostics.map((item) => item.code) }));
  return snapshot.complete ? 0 : 1;
}

if (import.meta.main) process.exit(run(process.argv.slice(2)));
