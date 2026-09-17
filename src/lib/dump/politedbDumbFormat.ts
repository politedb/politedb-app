/**
 * PoliteDB binary dump format (.dumb)
 *
 * Works for every SQL engine the app can dump: same SQL payload, wrapped in a
 * versioned binary container with gzip compression. Native tools (pg_dump -Fc,
 * etc.) are intentionally not used so one format covers postgres/mysql/sqlite/…
 *
 * Layout (version 1):
 *   0..3   magic "PDB1"
 *   4      flags (bit0 = payload is gzip)
 *   5..7   reserved (0)
 *   8..11  headerLen (u32 big-endian)
 *   12..   header JSON (utf-8)
 *   …      payload bytes (gzip UTF-8 SQL when bit0 set)
 *
 * Legacy plain-text .sql / early .dumb files are still accepted on unpack.
 */

export const DUMB_MAGIC = new TextEncoder().encode("PDB1");
export const DUMB_FLAG_GZIP = 0x01;
export const DUMB_FORMAT_NAME = "politedb-dumb";

export type PoliteDbDumbHeader = {
  format: typeof DUMB_FORMAT_NAME;
  version: 1;
  engine: string;
  createdAt: string;
  contentType: "sql";
};

export type UnpackDumpResult = {
  sql: string;
  engine: string | null;
  binary: boolean;
};

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function u32ToBytesBE(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (n >>> 24) & 0xff;
  out[1] = (n >>> 16) & 0xff;
  out[2] = (n >>> 8) & 0xff;
  out[3] = n & 0xff;
  return out;
}

function bytesToU32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function streamTransform(
  data: Uint8Array,
  stream: GenericTransformStream
): Promise<Uint8Array> {
  const blob = new Blob([data as BlobPart]);
  const compressed = blob.stream().pipeThrough(stream);
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

function canUseWebGzipStreams(): boolean {
  return (
    typeof CompressionStream !== "undefined" &&
    typeof DecompressionStream !== "undefined" &&
    typeof Blob !== "undefined" &&
    typeof (Blob.prototype as { stream?: unknown }).stream === "function"
  );
}

export async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  if (canUseWebGzipStreams()) {
    return streamTransform(data, new CompressionStream("gzip"));
  }
  // Node / vitest fallback (webview uses CompressionStream above)
  const { gzipSync } = await import("node:zlib");
  return new Uint8Array(gzipSync(Buffer.from(data)));
}

export async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  if (canUseWebGzipStreams()) {
    return streamTransform(data, new DecompressionStream("gzip"));
  }
  const { gunzipSync } = await import("node:zlib");
  return new Uint8Array(gunzipSync(Buffer.from(data)));
}

export function isPoliteDbDumbBinary(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return (
    bytes[0] === DUMB_MAGIC[0] &&
    bytes[1] === DUMB_MAGIC[1] &&
    bytes[2] === DUMB_MAGIC[2] &&
    bytes[3] === DUMB_MAGIC[3]
  );
}

export function buildDumbHeader(args: {
  engine: string;
  createdAt?: string;
}): PoliteDbDumbHeader {
  return {
    format: DUMB_FORMAT_NAME,
    version: 1,
    engine: args.engine,
    createdAt: args.createdAt ?? new Date().toISOString(),
    contentType: "sql",
  };
}

/** Frame header + payload into a .dumb binary (payload already compressed if flagged). */
export function encodeDumbBinary(args: {
  header: PoliteDbDumbHeader;
  payload: Uint8Array;
  gzip: boolean;
}): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(args.header));
  assert(headerBytes.length <= 0xffffffff, "Dump header too large");
  const flags = args.gzip ? DUMB_FLAG_GZIP : 0;
  return concatBytes([
    DUMB_MAGIC,
    new Uint8Array([flags, 0, 0, 0]),
    u32ToBytesBE(headerBytes.length),
    headerBytes,
    args.payload,
  ]);
}

export function decodeDumbBinary(bytes: Uint8Array): {
  header: PoliteDbDumbHeader;
  payload: Uint8Array;
  gzip: boolean;
} {
  assert(isPoliteDbDumbBinary(bytes), "Not a PoliteDB .dumb file");
  assert(bytes.length >= 12, "Truncated .dumb file");

  const flags = bytes[4]!;
  const headerLen = bytesToU32BE(bytes, 8);
  const headerStart = 12;
  const headerEnd = headerStart + headerLen;
  assert(headerEnd <= bytes.length, "Truncated .dumb header");

  const headerText = new TextDecoder().decode(
    bytes.subarray(headerStart, headerEnd)
  );
  let header: PoliteDbDumbHeader;
  try {
    header = JSON.parse(headerText) as PoliteDbDumbHeader;
  } catch {
    throw new Error("Invalid .dumb header JSON");
  }

  assert(header?.format === DUMB_FORMAT_NAME, "Unsupported dump format");
  assert(header?.version === 1, `Unsupported dump version: ${header?.version}`);
  assert(header?.contentType === "sql", "Unsupported dump content type");

  return {
    header,
    payload: bytes.subarray(headerEnd),
    gzip: (flags & DUMB_FLAG_GZIP) !== 0,
  };
}

/** Pack SQL text into a gzipped PoliteDB .dumb binary. */
export async function packSqlToDumb(args: {
  sql: string;
  engine: string;
  createdAt?: string;
}): Promise<Uint8Array> {
  const header = buildDumbHeader({
    engine: args.engine,
    createdAt: args.createdAt,
  });
  const sqlBytes = new TextEncoder().encode(args.sql);
  const payload = await gzipCompress(sqlBytes);
  return encodeDumbBinary({ header, payload, gzip: true });
}

/**
 * Unpack a dump file. Accepts binary .dumb (PDB1) or legacy plain SQL text
 * (including early .dumb files that were still SQL).
 */
export async function unpackDumpBytes(
  bytes: Uint8Array
): Promise<UnpackDumpResult> {
  if (isPoliteDbDumbBinary(bytes)) {
    const decoded = decodeDumbBinary(bytes);
    const raw = decoded.gzip
      ? await gzipDecompress(decoded.payload)
      : decoded.payload;
    const sql = new TextDecoder().decode(raw);
    return {
      sql,
      engine: decoded.header.engine || null,
      binary: true,
    };
  }

  // Legacy UTF-8 SQL (strip UTF-8 BOM if present)
  let sql = new TextDecoder().decode(bytes);
  if (sql.charCodeAt(0) === 0xfeff) sql = sql.slice(1);
  return { sql, engine: null, binary: false };
}
