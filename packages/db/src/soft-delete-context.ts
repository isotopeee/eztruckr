import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Opt-in escapes from the default "hide deleted rows" behaviour.
 *
 * Both are deliberately awkward to reach. The default must be the safe one,
 * because the failure mode of forgetting a filter is a deleted commission
 * reappearing in a voucher or a deleted shipment skewing the P&L — silent,
 * and financial.
 */
export interface SoftDeleteScope {
  /** Reads return deleted rows too. For admin "view deleted" and restore. */
  includeDeleted: boolean;
  /**
   * Permits a real SQL DELETE. Never use in application code; this exists for
   * test teardown and a deliberate administrative purge.
   */
  allowHardDelete: boolean;
}

const storage = new AsyncLocalStorage<SoftDeleteScope>();

const DEFAULT_SCOPE: SoftDeleteScope = {
  includeDeleted: false,
  allowHardDelete: false,
};

export function getSoftDeleteScope(): SoftDeleteScope {
  return storage.getStore() ?? DEFAULT_SCOPE;
}

/**
 * Run `fn` with deleted rows visible. Scoped to the async context, so it
 * cannot leak into a concurrent request.
 */
export function withDeleted<T>(fn: () => T): T {
  return storage.run({ ...getSoftDeleteScope(), includeDeleted: true }, fn);
}

/**
 * Run `fn` with real DELETEs permitted, and with deleted rows visible so the
 * target can actually be found.
 */
export function withHardDelete<T>(fn: () => T): T {
  return storage.run({ includeDeleted: true, allowHardDelete: true }, fn);
}
