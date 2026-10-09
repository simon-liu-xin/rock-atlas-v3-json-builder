#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { buildCatalogGateAReport } from "../src/data/gates/catalog-gate-a.ts";

const execFileAsync = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
if (!args.evidenceDir || !args.output || !args.v2PointerBefore || !args.v2PointerAfter) {
  process.stderr.write(
    "Usage: node scripts/build-catalog-gate-a-report.mjs --evidence-dir <dir> --output <file> " +
    "--v2-pointer-before <file> --v2-pointer-after <file> [--commit <sha>] [--report-only]\n",
  );
  process.exitCode = 2;
} else {
  const evidence = await readEvidence(resolve(args.evidenceDir));
  const commit = args.commit ?? (await execFileAsync("git", ["rev-parse", "HEAD"])).stdout.trim();
  const report = buildCatalogGateAReport({
    commit,
    generated_at: new Date().toISOString(),
    evidence,
    v2_pointer_before_sha256: await fileSha256(resolve(args.v2PointerBefore)),
    v2_pointer_after_sha256: await fileSha256(resolve(args.v2PointerAfter)),
  });
  const output = resolve(args.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output, status: report.status, blockers: report.blockers.length })}\n`);
  if (report.status !== "pass" && !args.reportOnly) process.exitCode = 1;
}

async function readEvidence(directory) {
  const files = await readdir(directory).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return Promise.all(files.filter((file) => file.endsWith(".json")).sort().map(async (file) =>
    JSON.parse(await readFile(resolve(directory, file), "utf8"))
  ));
}

async function fileSha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function parseArgs(argv) {
  const result = { reportOnly: argv.includes("--report-only") };
  const names = new Map([
    ["--evidence-dir", "evidenceDir"], ["--output", "output"],
    ["--v2-pointer-before", "v2PointerBefore"], ["--v2-pointer-after", "v2PointerAfter"],
    ["--commit", "commit"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = names.get(argv[index]);
    if (field) result[field] = argv[++index];
  }
  return result;
}
