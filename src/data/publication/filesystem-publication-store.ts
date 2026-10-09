import { constants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export class FilesystemPublicationStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async putImmutable(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(dirname(path));
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      const existing = await readFile(path);
      if (!existing.equals(Buffer.from(bytes))) {
        throw new Error(`Immutable publication object already exists with different bytes: ${key}`);
      }
    }
  }

  async read(key: string): Promise<Uint8Array> {
    return readFile(this.#path(key));
  }

  async readIfExists(key: string): Promise<Uint8Array | null> {
    try {
      return await this.read(key);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  async replacePointerAtomically(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
      await syncDirectory(dirname(path));
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async withPointerLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const lockPath = this.#path(`${key}.lock`);
    await mkdir(dirname(lockPath), { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        break;
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) throw error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    }
    if (!handle) throw new Error(`Timed out acquiring publication pointer lock for ${key}`);
    try {
      await handle.writeFile(`${process.pid}\n`);
      await handle.sync();
      return await action();
    } finally {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async *list(prefix = ""): AsyncIterable<string> {
    const start = this.#path(prefix || ".");
    const entries = await readdir(start, { recursive: true, withFileTypes: true }).catch((error) => {
      if (isErrorCode(error, "ENOENT")) return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const parent = "parentPath" in entry ? entry.parentPath : start;
      yield relative(this.#root, resolve(String(parent), entry.name));
    }
  }

  #path(key: string): string {
    if (!key || key.includes("\0") || key.startsWith("/") || key.startsWith("\\")) {
      throw new Error(`Unsafe publication key: ${key}`);
    }
    const path = resolve(this.#root, key);
    if (path !== this.#root && !path.startsWith(`${this.#root}${sep}`)) {
      throw new Error(`Publication key escapes root: ${key}`);
    }
    return path;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
