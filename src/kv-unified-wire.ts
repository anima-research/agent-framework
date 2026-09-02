/** Structural copy of membrane's cache-wire receipt contract.
 * Kept local so agent-framework remains source-compatible with the previous
 * membrane release while the stacked membrane PR lands. */
export interface CacheWireReceipt {
  requestHash: string;
  markers: Array<{ ordinal: number; prefixHash: string; estimatedOffset: number }>;
}

export interface KvUnifiedRequestHooks {
  cacheMarkers?: 'membrane-system' | 'cm-owned';
  onCacheWireReceipt?: (receipt: CacheWireReceipt) => void;
}
