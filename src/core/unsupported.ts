export class NotImplemented extends Error {
  readonly status = 501;
  readonly code = 'not_implemented';
  constructor(readonly operation: string, readonly availableIn: string) {
    super(`not_implemented: ${operation} (available in ${availableIn})`);
  }
}
export function unsupported(operation: string, availableIn: string): never { throw new NotImplemented(operation, availableIn); }
