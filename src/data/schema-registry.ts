import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { MusicWikiError } from "../errors.ts";

export const schemaIds = [
  "assertion-v1",
  "catalog-namespace-manifest-v3",
  "catalog-pointer-v3",
  "catalog-root-manifest-v3",
  "candidate-view-model-v1",
  "cli-result-v1",
  "conflict-set-v1",
  "coverage-state-v1",
  "evidence-v1",
  "experiment-view-state-v1",
  "external-identity-assertion-v1",
  "identity-event-v1",
  "package-inclusion-v1",
  "provenance-v1",
  "projection-manifest-v1",
  "render-policy-v1",
  "research-event-v1",
  "research-observation-v1",
  "research-readiness-v1",
  "source-license-decision-v1",
  "style-relation-v2",
] as const;

export type SchemaId = (typeof schemaIds)[number];

const schemaDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../schemas");
const validatorCache = new Map<SchemaId, Promise<ValidateFunction>>();

export async function validateSchemaDocument(schemaId: SchemaId, value: unknown): Promise<void> {
  const validator = await getValidator(schemaId);
  if (validator(value)) return;

  throw new MusicWikiError({
    code: "MW_PACK_SCHEMA_INVALID",
    exitCode: 4,
    message: `Document does not satisfy ${schemaId}.`,
    cause: formatErrors(validator.errors),
    hint: "Correct the document fields and validate it again before publishing.",
    docsUrl: "docs/data/schema.md#schema-registry",
    details: { schema_id: schemaId, errors: validator.errors ?? [] },
  });
}

async function getValidator(schemaId: SchemaId): Promise<ValidateFunction> {
  let pending = validatorCache.get(schemaId);
  if (!pending) {
    pending = compileSchema(schemaId);
    validatorCache.set(schemaId, pending);
  }
  return pending;
}

async function compileSchema(schemaId: SchemaId): Promise<ValidateFunction> {
  const schema = JSON.parse(
    await readFile(resolve(schemaDirectory, `${schemaId}.schema.json`), "utf8"),
  ) as AnySchema;
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}
