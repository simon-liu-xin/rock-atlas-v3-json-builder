import { execFile } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

describe("catalog signing key CLI", () => {
  test("writes a private Ed25519 key with owner-only permissions and matching public JWK", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalog-key-"));
    const privatePath = join(root, "catalog-private.pem");
    const publicPath = join(root, "catalog-public.jwk.json");
    const result = await execFileAsync(process.execPath, [
      resolve("scripts/offline-data/generate_catalog_signing_key.mjs"),
      "--private-key", privatePath,
      "--public-jwk", publicPath,
      "--key-id", "catalog-production-2026",
    ]);
    expect(result.stdout).not.toContain("PRIVATE KEY");
    expect((await stat(privatePath)).mode & 0o077).toBe(0);
    const privateKey = createPrivateKey(await readFile(privatePath));
    const publicDocument = JSON.parse(await readFile(publicPath, "utf8"));
    expect(publicDocument).toMatchObject({ key_id: "catalog-production-2026", algorithm: "Ed25519" });
    expect(createPublicKey(privateKey).export({ format: "jwk" })).toEqual(publicDocument.jwk);
  });
});
