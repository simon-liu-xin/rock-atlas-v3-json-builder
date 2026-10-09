#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { CATALOG_GATE_A_REQUIRED_CHECKS } from "../src/data/gates/catalog-gate-a.ts";

const execFileAsync = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
if (!args.checkId || !args.output || !args.artifactPath) {
  process.stderr.write(
    "Usage: node scripts/write-catalog-gate-evidence.mjs --check-id <id> " +
    "--artifact-path <path> --output <file> [--commit <sha>]\n",
  );
  process.exitCode = 2;
} else if (!CATALOG_GATE_A_REQUIRED_CHECKS.includes(args.checkId)) {
  throw new Error(`Unknown Catalog Gate A check id ${args.checkId}`);
} else {
  const commit = args.commit ?? (await execFileAsync("git", ["rev-parse", "HEAD"])).stdout.trim();
  const output = resolve(args.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({
    evidence_version: "1.0",
    check_id: args.checkId,
    status: "pass",
    commit,
    recorded_at: new Date().toISOString(),
    artifact_path: args.artifactPath,
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`${output}\n`);
}

function parseArgs(argv) {
  const result = {};
  const names = new Map([
    ["--check-id", "checkId"], ["--artifact-path", "artifactPath"],
    ["--output", "output"], ["--commit", "commit"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = names.get(argv[index]);
    if (field) result[field] = argv[++index];
  }
  return result;
}
