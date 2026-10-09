import {
  createHash,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

import {
  canonicalJsonV1,
  type CatalogPointerV3,
} from "../contracts/catalog-v3.ts";

export type CatalogPrivateKey = KeyObject | string | Buffer;
export type CatalogPublicKey = KeyObject | string | Buffer;

export type UnsignedCatalogPointerV3 = Omit<CatalogPointerV3, "signature">;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function signCatalogPointer(
  pointer: UnsignedCatalogPointerV3,
  privateKey: CatalogPrivateKey,
): CatalogPointerV3 {
  const payload = Buffer.from(canonicalJsonV1(pointer), "utf8");
  const signature = sign(null, payload, privateKey).toString("base64url");
  if (signature.length !== 86) {
    throw new Error("Catalog pointer Ed25519 signature has an invalid encoded length");
  }
  return { ...pointer, signature };
}

export function verifyCatalogPointerSignature(
  pointer: CatalogPointerV3,
  trustedKeys: Readonly<Record<string, CatalogPublicKey>>,
): { readonly verified: true } | { readonly verified: false; readonly reason: string } {
  const key = trustedKeys[pointer.key_id];
  if (!key) return { verified: false, reason: `Unknown catalog signing key ${pointer.key_id}` };
  const { signature, ...unsigned } = pointer;
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, "base64url");
  } catch {
    return { verified: false, reason: "Catalog pointer signature is malformed" };
  }
  if (signatureBytes.byteLength !== 64) {
    return { verified: false, reason: "Catalog pointer signature is malformed" };
  }
  const valid = verify(
    null,
    Buffer.from(canonicalJsonV1(unsigned), "utf8"),
    key,
    signatureBytes,
  );
  return valid
    ? { verified: true }
    : { verified: false, reason: "Catalog pointer signature verification failed" };
}
