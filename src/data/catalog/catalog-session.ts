export class CatalogSession {
  readonly cache = new Map<string, unknown>();
  readonly inFlight = new Map<string, Promise<unknown>>();
  readonly abortController = new AbortController();
  #released = false;

  constructor(
    readonly generation_id: string,
    readonly channel: "rock-catalog-v2" | "rock-catalog-v3",
    readonly schema_version: string,
    readonly layout_version: string,
    readonly normalization_versions: Readonly<{
      search: string;
      identity: string;
      source_match: string;
      canonical_json: string;
    }>,
  ) {
    Object.freeze(this.normalization_versions);
  }

  get released(): boolean {
    return this.#released;
  }

  assertActive(): void {
    if (this.#released) throw new Error(`Catalog session ${this.generation_id} has been released`);
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.abortController.abort();
    this.cache.clear();
    this.inFlight.clear();
  }
}
