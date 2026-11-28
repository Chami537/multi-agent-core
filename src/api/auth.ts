import type { IncomingMessage } from 'node:http';
import { sha256Hex } from './protocol.js';
import type { Scope, TokenConfig } from './types.js';

export interface AuthPrincipal {
  principal: string;
  token_id: string;
  scopes: Scope[];
  projects: string[];
  expires_at: string | null;
  rate_limit: {
    requests_per_s: number;
    burst: number;
    runs_per_min: number;
    sse_connections: number;
  };
}

export class TokenRegistry {
  private readonly byHash = new Map<string, AuthPrincipal>();

  constructor(configs: TokenConfig[]) {
    for (const cfg of configs) {
      const hash = cfg.tokenHash ?? (cfg.token ? sha256Hex(cfg.token) : null);
      if (!hash) throw new Error(`token_config_missing_secret: ${cfg.token_id}`);
      this.byHash.set(hash, {
        principal: cfg.principal,
        token_id: cfg.token_id,
        scopes: [...cfg.scopes],
        projects: [...cfg.projects],
        expires_at: cfg.expires_at ?? null,
        rate_limit: cfg.rate_limit ?? { requests_per_s: 10, burst: 50, runs_per_min: 120, sse_connections: 4 },
      });
    }
  }

  authenticate(req: IncomingMessage, now = Date.now()): AuthPrincipal | null {
    const raw = req.headers.authorization;
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return null;
    const token = match[1]!.trim();
    if (!token) return null;
    const hash = sha256Hex(token);
    const entry = this.byHash.get(hash);
    if (!entry) return null;
    if (entry.expires_at !== null && Date.parse(entry.expires_at) <= now) return null;
    return entry;
  }

  hasScope(principal: AuthPrincipal, scope: Scope): boolean {
    return principal.scopes.includes(scope);
  }

  allowsProject(principal: AuthPrincipal, projectId: string): boolean {
    return principal.projects.includes('*') || principal.projects.includes(projectId);
  }
}
