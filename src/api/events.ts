import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GlobalEvent, Store } from '../store/database.js';
import type { AuthPrincipal } from './auth.js';
import { sendError, sendJson } from './protocol.js';

const DEFAULT_EXCLUDED_TYPES = new Set(['run.activity', 'journal.appended']);
const INSTANCE_LEVEL_EVENTS = new Set([
  'instance.started',
  'capabilities.updated',
  'runner.health_changed',
  'account.status_changed',
]);

function matchesTypes(type: string, filterTypes: string[] | null): boolean {
  if (!filterTypes) return !DEFAULT_EXCLUDED_TYPES.has(type);
  for (const pat of filterTypes) {
    if (pat.endsWith('.*')) {
      const prefix = pat.slice(0, -1);
      if (type.startsWith(prefix)) return true;
    } else if (type === pat) {
      return true;
    }
  }
  return false;
}

function matchesEvent(
  ev: GlobalEvent,
  principal: AuthPrincipal,
  projects: string[],
  tasks: string[],
  runs: string[],
  filterTypes: string[] | null,
): boolean {
  if (ev.project_id === null) {
    if (!INSTANCE_LEVEL_EVENTS.has(ev.type)) return false;
  } else if (!principal.projects.includes('*') && !principal.projects.includes(ev.project_id)) {
    return false;
  }
  if (projects.length > 0 && (ev.project_id === null || !projects.includes(ev.project_id))) return false;
  if (tasks.length > 0 && (ev.task_id === null || !tasks.includes(ev.task_id))) return false;
  if (runs.length > 0 && (ev.run_id === null || !runs.includes(ev.run_id))) return false;
  return matchesTypes(ev.type, filterTypes);
}

export function handleEventsEndpoint(params: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  store: Store;
  principal: AuthPrincipal;
  effectiveVersion: string;
  requestId: string;
  extraHeaders: Record<string, string>;
  keepaliveMs?: number;
  pollMs?: number;
}): void {
  const { req, res, url, store, principal, effectiveVersion, requestId, extraHeaders } = params;
  const accept = String(req.headers.accept ?? 'application/json');
  const isSse = accept.includes('text/event-stream');

  const lastEventIdRaw = req.headers['last-event-id'];
  const lastEventId = Array.isArray(lastEventIdRaw) ? lastEventIdRaw[0] : lastEventIdRaw;
  const sinceRaw = lastEventId ?? url.searchParams.get('since');

  let since: number | null = null;
  if (sinceRaw !== null && sinceRaw !== '') {
    const parsed = Number(sinceRaw);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      sendError(res, {
        status: 400,
        code: 'invalid_request',
        message: 'since / Last-Event-ID must be a non-negative integer',
        requestId,
        headers: { 'Supervisor-Protocol': effectiveVersion, ...extraHeaders },
      });
      return;
    }
    since = parsed;
  }

  const projects = url.searchParams.getAll('project_id');
  const tasks = url.searchParams.getAll('task_id');
  const runs = url.searchParams.getAll('run_id');
  const typesParam = url.searchParams.get('types');
  const filterTypes = typesParam ? typesParam.split(',').map(s => s.trim()).filter(Boolean) : null;

  if (!isSse) {
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam !== null ? Number(limitParam) : 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      sendError(res, {
        status: 400,
        code: 'invalid_request',
        message: 'limit must be an integer between 1 and 1000',
        requestId,
        headers: { 'Supervisor-Protocol': effectiveVersion, ...extraHeaders },
      });
      return;
    }
    const effectiveSince = since ?? 0;
    const page = store.eventsSince(effectiveSince, limit);
    if (page.reset) {
      sendJson(
        res,
        200,
        {
          events: [],
          next_since: effectiveSince,
          complete_from_seq: page.complete_from_seq,
          reset: true,
        },
        {
          'Supervisor-Protocol': effectiveVersion,
          'Event-Seq': String(page.event_seq),
          'Request-Id': requestId,
          ...extraHeaders,
        },
      );
      return;
    }
    const filtered = page.events.filter(e => matchesEvent(e, principal, projects, tasks, runs, filterTypes));
    const nextSince = page.events.length > 0 ? page.events[page.events.length - 1]!.seq : effectiveSince;
    sendJson(
      res,
      200,
      {
        events: filtered,
        next_since: nextSince,
        complete_from_seq: page.complete_from_seq,
        reset: false,
      },
      {
        'Supervisor-Protocol': effectiveVersion,
        'Event-Seq': String(page.event_seq),
        'Request-Id': requestId,
        ...extraHeaders,
      },
    );
    return;
  }

  // SSE stream
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Supervisor-Protocol': effectiveVersion,
    'Request-Id': requestId,
    ...extraHeaders,
  });
  res.write('retry: 3000\n\n');

  const meta = store.meta();
  if (since !== null && since + 1 < meta.complete) {
    const resetFrame = {
      type: 'stream.reset',
      ts: new Date().toISOString(),
      data: {
        complete_from_seq: meta.complete,
        requested_since: since,
        reason: 'retention',
      },
    };
    res.write(`event: stream.reset\ndata: ${JSON.stringify(resetFrame)}\n\n`);
    res.end();
    return;
  }

  let cursorSeq = since !== null ? since : meta.high;
  let closed = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let keepaliveTimer: NodeJS.Timeout | null = null;

  const cleanup = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (closed) return;
    closed = true;
  };

  const flushNewEvents = () => {
    if (closed) return;
    try {
      while (true) {
        const batch = store.eventsSince(cursorSeq, 200);
        if (batch.reset) {
          const resetFrame = {
            type: 'stream.reset',
            ts: new Date().toISOString(),
            data: {
              complete_from_seq: batch.complete_from_seq,
              requested_since: cursorSeq,
              reason: 'retention',
            },
          };
          res.write(`event: stream.reset\ndata: ${JSON.stringify(resetFrame)}\n\n`);
          cleanup();
          res.end();
          return;
        }
        if (batch.events.length === 0) break;
        for (const ev of batch.events) {
          cursorSeq = ev.seq;
          if (matchesEvent(ev, principal, projects, tasks, runs, filterTypes)) {
            res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
          }
        }
        if (batch.events.length < 200) break;
      }
    } catch {
      // Ignore if store closed during shutdown
    }
  };

  flushNewEvents();
  if (closed) return;

  pollTimer = setInterval(flushNewEvents, params.pollMs ?? 30);
  keepaliveTimer = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n');
  }, params.keepaliveMs ?? 15_000);

  req.on('close', cleanup);
  res.on('close', cleanup);
}
