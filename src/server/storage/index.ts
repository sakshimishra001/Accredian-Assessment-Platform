import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { StorageClient } from "@supabase/storage-js";
import { env } from "../env";

/*
 * Storage abstraction. The application stores and reads file bytes only through this interface,
 * using opaque keys it generated itself; PostgreSQL keeps the metadata (see StoredFile). Drivers:
 * a local folder (development), memory (tests) and a private Supabase Storage bucket (production).
 * Every read goes through the application's own authorization (services/files.ts): no driver ever
 * hands out public or signed URLs.
 */

export interface StorageProvider {
  /** Driver name stored with each file, so a file is always read back from where it was written. */
  readonly name: string;
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Idempotent: deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
}

/** Keys look like "answer/2026/10/<uuid>.pdf" — generated here, never taken from a client. */
const KEY_RE = /^(material|answer)\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{1,8}$/;

export function newStorageKey(purpose: "material" | "answer", extension: string, now = new Date()): string {
  const key = `${purpose}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}.${extension}`;
  assertKey(key);
  return key;
}

function assertKey(key: string) {
  if (!KEY_RE.test(key)) throw new Error("Invalid storage key.");
}

/** Files on a local disk folder. Keys are validated and resolved strictly inside the root. */
export class LocalDiskStorage implements StorageProvider {
  readonly name = "local";
  constructor(private readonly root: string) {}

  private pathOf(key: string) {
    assertKey(key);
    const root = path.resolve(this.root);
    const full = path.resolve(root, ...key.split("/"));
    if (!full.startsWith(root + path.sep)) throw new Error("Invalid storage key.");
    return full;
  }

  async put(key: string, data: Buffer) {
    const full = this.pathOf(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data, { flag: "wx" });
  }

  async get(key: string) {
    return readFile(this.pathOf(key));
  }

  async delete(key: string) {
    await rm(this.pathOf(key), { force: true });
  }
}

/** In-memory storage for tests: nothing touches the disk. */
export class MemoryStorage implements StorageProvider {
  readonly name = "memory";
  private readonly objects = new Map<string, Buffer>();

  async put(key: string, data: Buffer) {
    assertKey(key);
    if (this.objects.has(key)) throw new Error("Object already exists.");
    this.objects.set(key, Buffer.from(data));
  }

  async get(key: string) {
    assertKey(key);
    const data = this.objects.get(key);
    if (!data) throw Object.assign(new Error("Object not found."), { code: "ENOENT" });
    return Buffer.from(data);
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  /** Test helper: keys currently stored. */
  keys() {
    return [...this.objects.keys()];
  }
}

/**
 * A private Supabase Storage bucket, reached from the server only with the service-role key (which
 * bypasses Storage policies — so it must never reach a browser; this module is server-only and the
 * key is read from a non-public environment variable). Objects are written under the same opaque,
 * server-generated keys as the other drivers, never overwritten, and always served through the
 * application (no public or signed URLs).
 */
export class SupabaseStorage implements StorageProvider {
  readonly name = "supabase";
  private readonly files: ReturnType<StorageClient["from"]>;

  constructor(opts: { url: string; serviceRoleKey: string; bucket: string; fetch?: typeof fetch }) {
    const endpoint = `${opts.url.replace(/\/+$/, "")}/storage/v1`;
    const client = new StorageClient(endpoint, { apikey: opts.serviceRoleKey, Authorization: `Bearer ${opts.serviceRoleKey}` }, opts.fetch);
    this.files = client.from(opts.bucket);
  }

  async put(key: string, data: Buffer) {
    assertKey(key);
    // The bytes are served by the app with their own headers; the object itself is opaque.
    const { error } = await this.files.upload(key, data, { upsert: false, contentType: "application/octet-stream" });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
  }

  async get(key: string) {
    assertKey(key);
    const { data, error } = await this.files.download(key);
    if (error || !data) {
      const status = error && "status" in error ? Number((error as { status?: unknown }).status) : undefined;
      if (status === 404 || /not.?found/i.test(error?.message ?? "")) throw Object.assign(new Error("Object not found."), { code: "ENOENT" });
      throw new Error(`Storage download failed: ${error?.message ?? "no data"}`);
    }
    return Buffer.from(await data.arrayBuffer());
  }

  async delete(key: string) {
    assertKey(key);
    // Removing a missing object succeeds (an empty result), so this is idempotent.
    const { error } = await this.files.remove([key]);
    if (error) throw new Error(`Storage delete failed: ${error.message}`);
  }
}

let provider: StorageProvider | undefined;

/** The configured storage provider (STORAGE_DRIVER), created once per process. */
export function storage(): StorageProvider {
  if (provider) return provider;
  const e = env();
  if (e.STORAGE_DRIVER === "memory") provider = new MemoryStorage();
  else if (e.STORAGE_DRIVER === "supabase") {
    if (!e.SUPABASE_URL || !e.SUPABASE_SERVICE_ROLE_KEY) throw new Error('STORAGE_DRIVER "supabase" needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    provider = new SupabaseStorage({ url: e.SUPABASE_URL, serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY, bucket: e.SUPABASE_STORAGE_BUCKET });
  } else provider = new LocalDiskStorage(e.STORAGE_LOCAL_DIR ?? path.join(homedir(), ".accredian-assessment", "storage"));
  return provider;
}

/** The provider a stored file was written with (only the configured one is available). */
export function storageFor(driver: string): StorageProvider {
  const p = storage();
  if (p.name !== driver) throw new Error(`File is stored with "${driver}", but storage is configured as "${p.name}".`);
  return p;
}
