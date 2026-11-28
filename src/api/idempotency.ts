import type { Store } from '../store/database.js';
import { canonicalJson, sha256Hex } from './protocol.js';

export const DEFAULT_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyRecord {
  principal: string;
  method: string;
  path: string;
  idempotency_key: string;
  fingerprint: string;
  request_id: string;
  status: 'in_progress' | 'completed';
  boot_id: string;
  permanent: boolean;
  status_code: number | null;
  response_body: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface IdempotencyScope {
  principal: string;
  method: string;
  path: string;
  key: string;
}

export function validateIdempotencyKey(raw: string | string[] | undefined): { ok: true; key: string } | { ok: false; code: 'idempotency_key_required' | 'invalid_request'; message: string } {
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (val === undefined || val === '') {
    return { ok: false, code: 'idempotency_key_required', message: 'Missing Idempotency-Key header' };
  }
  if (!/^[\x21-\x7E]{1,128}$/.test(val)) {
    return { ok: false, code: 'invalid_request', message: 'Idempotency-Key must be 1-128 visible ASCII characters' };
  }
  return { ok: true, key: val };
}

export function computeRequestFingerprint(params: {
  protocol: string;
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  body: unknown;
}): string {
  const canonical = canonicalJson({
    protocol: params.protocol,
    method: params.method,
    path: params.path,
    query: params.query,
    body: params.body === undefined ? null : params.body,
  });
  return sha256Hex(canonical);
}

export function shouldRecordStatus(status: number): boolean {
  if (status >= 200 && status < 300) return true;
  return [400, 403, 404, 409, 412, 422].includes(status);
}

export class IdempotencyManager {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly bootId: string,
    private readonly windowMs = DEFAULT_IDEMPOTENCY_WINDOW_MS,
  ) {
    this.cleanStaleInProgress();
  }

  private slotKey(s: IdempotencyScope): string {
    return `${s.principal}\0${s.method}\0${s.path}\0${s.key}`;
  }

  cleanStaleInProgress(): void {
    this.store.transaction(() => {
      this.store.db.prepare(`DELETE FROM api_idempotency WHERE status='in_progress' AND boot_id!=?`).run(this.bootId);
    });
  }

  checkAndAcquire(
    scope: IdempotencyScope,
    fingerprint: string,
    requestId: string,
    permanent: boolean,
    now = Date.now(),
  ):
    | { action: 'execute' }
    | { action: 'replay'; statusCode: number; body: string }
    | { action: 'conflict'; firstRequestId: string; firstRequestedAt: string }
    | { action: 'in_progress' } {
    const slot = this.slotKey(scope);
    return this.store.transaction(() => {
      const row = this.store.db
        .prepare(
          `SELECT * FROM api_idempotency WHERE principal=? AND method=? AND path=? AND idempotency_key=?`,
        )
        .get(scope.principal, scope.method, scope.path, scope.key) as Record<string, unknown> | undefined;

      if (row) {
        const status = row.status as string;
        if (status === 'in_progress') {
          if (row.boot_id === this.bootId && this.inFlight.has(slot)) {
            return { action: 'in_progress' as const };
          }
          // Orphaned in_progress from crashed/uncleaned request in same or old boot
          this.store.db
            .prepare(`DELETE FROM api_idempotency WHERE principal=? AND method=? AND path=? AND idempotency_key=?`)
            .run(scope.principal, scope.method, scope.path, scope.key);
        } else if (status === 'completed') {
          const isPerm = Number(row.permanent) === 1;
          const completedAt = Number(row.completed_at ?? row.created_at);
          if (!isPerm && now - completedAt > this.windowMs) {
            this.store.db
              .prepare(`DELETE FROM api_idempotency WHERE principal=? AND method=? AND path=? AND idempotency_key=?`)
              .run(scope.principal, scope.method, scope.path, scope.key);
          } else if (row.fingerprint !== fingerprint) {
            return {
              action: 'conflict' as const,
              firstRequestId: String(row.request_id),
              firstRequestedAt: new Date(Number(row.created_at)).toISOString(),
            };
          } else {
            return {
              action: 'replay' as const,
              statusCode: Number(row.status_code),
              body: String(row.response_body),
            };
          }
        }
      }

      this.store.db
        .prepare(
          `INSERT INTO api_idempotency(principal, method, path, idempotency_key, fingerprint, request_id, status, boot_id, permanent, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          scope.principal,
          scope.method,
          scope.path,
          scope.key,
          fingerprint,
          requestId,
          'in_progress',
          this.bootId,
          permanent ? 1 : 0,
          now,
        );
      this.inFlight.add(slot);
      return { action: 'execute' as const };
    });
  }

  /** Must be called inside an active store.transaction(...)! */
  completeInTransaction(scope: IdempotencyScope, statusCode: number, responseBody: string, now = Date.now()): void {
    this.store.db
      .prepare(
        `UPDATE api_idempotency SET status='completed', status_code=?, response_body=?, completed_at=?
         WHERE principal=? AND method=? AND path=? AND idempotency_key=?`,
      )
      .run(statusCode, responseBody, now, scope.principal, scope.method, scope.path, scope.key);
  }

  completeStandalone(scope: IdempotencyScope, statusCode: number, responseBody: string, now = Date.now()): void {
    this.store.transaction(() => {
      this.completeInTransaction(scope, statusCode, responseBody, now);
    });
  }

  releaseInFlight(scope: IdempotencyScope, deleteRecord: boolean): void {
    this.inFlight.delete(this.slotKey(scope));
    if (deleteRecord) {
      try {
        this.store.transaction(() => {
          this.store.db
            .prepare(`DELETE FROM api_idempotency WHERE principal=? AND method=? AND path=? AND idempotency_key=? AND status='in_progress'`)
            .run(scope.principal, scope.method, scope.path, scope.key);
        });
      } catch {
        // Best-effort cleanup if DB is closing
      }
    }
  }
}
