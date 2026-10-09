export type MusicWikiErrorCode =
  | "MW_ASSERTION_EVIDENCE_MISSING"
  | "MW_ASSERTION_INVALID"
  | "MW_IDENTITY_EVENT_INVALID"
  | "MW_IDENTITY_REDIRECT_CYCLE"
  | "MW_IDENTITY_TARGET_MISSING"
  | "MW_LICENSE_LINEAGE_INVALID"
  | "MW_PACK_HASH_MISMATCH"
  | "MW_PACK_MANIFEST_INVALID"
  | "MW_PACK_INCOMPLETE"
  | "MW_PACK_NOT_FOUND"
  | "MW_PACK_OUTPUT_EXISTS"
  | "MW_PACK_SCHEMA_INVALID"
  | "MW_PACK_SCHEMA_UNSUPPORTED"
  | "MW_LICENSE_BLOCKED"
  | "MW_ENV_NODE_UNSUPPORTED"
  | "MW_USAGE_INVALID_ARGUMENT"
  | "MW_INTERNAL";

interface MusicWikiErrorOptions {
  code: MusicWikiErrorCode;
  exitCode: 1 | 2 | 3 | 4 | 5;
  message: string;
  cause: string;
  hint: string;
  docsUrl: string;
  details?: Record<string, unknown>;
}

export class MusicWikiError extends Error {
  readonly code: MusicWikiErrorCode;
  readonly exitCode: 1 | 2 | 3 | 4 | 5;
  readonly causeText: string;
  readonly hint: string;
  readonly docsUrl: string;
  readonly details: Record<string, unknown>;

  constructor(options: MusicWikiErrorOptions) {
    super(options.message);
    this.name = "MusicWikiError";
    this.code = options.code;
    this.exitCode = options.exitCode;
    this.causeText = options.cause;
    this.hint = options.hint;
    this.docsUrl = options.docsUrl;
    this.details = options.details ?? {};
  }
}
