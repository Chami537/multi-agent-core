import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PROTOCOL_VERSION, SUPPORTED_VERSIONS } from './types.js';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(prefix: string, now = Date.now()): string {
  let time = now;
  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = ULID_ALPHABET[time % 32]! + timePart;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(16);
  let randPart = '';
  for (let i = 0; i < 16; i++) {
    randPart += ULID_ALPHABET[bytes[i]! & 31]!;
  }
  return `${prefix}_${timePart}${randPart}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(v => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function normalizePath(pathname: string): string {
  let decoded = pathname.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => {
    const code = Number.parseInt(hex, 16);
    const ch = String.fromCharCode(code);
    // Unreserved RFC 3986 characters: ALPHA / DIGIT / "-" / "." / "_" / "~"
    if (/^[A-Za-z0-9\-._~]$/.test(ch)) return ch;
    return `%${hex.toUpperCase()}`;
  });
  if (decoded.length > 1 && decoded.endsWith('/')) decoded = decoded.slice(0, -1);
  return decoded;
}

export interface ApiErrorOptions {
  status: number;
  code: string;
  message: string;
  retryable?: boolean;
  retry_after_s?: number | null;
  requestId: string;
  details?: Record<string, unknown>;
  violations?: unknown[];
  headers?: Record<string, string>;
}

export function buildErrorBody(opts: ApiErrorOptions): Record<string, unknown> {
  const err: Record<string, unknown> = {
    code: opts.code,
    message: opts.message,
    retryable: opts.retryable ?? false,
    retry_after_s: opts.retry_after_s ?? null,
    request_id: opts.requestId,
  };
  if (opts.details !== undefined) err.details = opts.details;
  if (opts.violations !== undefined) err.violations = opts.violations;
  return { error: err };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(json);
}

export function sendError(res: ServerResponse, opts: ApiErrorOptions): void {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.retry_after_s != null) headers['Retry-After'] = String(opts.retry_after_s);
  sendJson(res, opts.status, buildErrorBody(opts), headers);
}

export type VersionResult =
  | { ok: true; effective: string; warning?: string }
  | { ok: false; reason: 'missing' | 'unsupported'; message: string };

export function negotiateVersion(req: IncomingMessage, isWrite: boolean): VersionResult {
  const raw = req.headers['supervisor-protocol'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header || header.trim() === '') {
    if (isWrite) {
      return { ok: false, reason: 'missing', message: 'Missing Supervisor-Protocol header on write request' };
    }
    return { ok: true, effective: PROTOCOL_VERSION, warning: '299 - "missing Supervisor-Protocol"' };
  }
  const trimmed = header.trim();
  const match = /^(\d+)\.(\d+)$/.exec(trimmed);
  if (!match) {
    return { ok: false, reason: 'unsupported', message: `Unsupported Supervisor-Protocol: ${trimmed}` };
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== 0 || minor < 2) {
    return { ok: false, reason: 'unsupported', message: `Unsupported Supervisor-Protocol: ${trimmed}` };
  }
  if (isWrite) {
    if (!(SUPPORTED_VERSIONS as readonly string[]).includes(trimmed)) {
      return { ok: false, reason: 'unsupported', message: `Write request requires exact supported version (${SUPPORTED_VERSIONS.join(', ')}), got ${trimmed}` };
    }
    return { ok: true, effective: trimmed };
  }
  // Read request: min(client MINOR, highest supported MINOR)
  const effectiveMinor = Math.min(minor, 2);
  return { ok: true, effective: `0.${effectiveMinor}` };
}
