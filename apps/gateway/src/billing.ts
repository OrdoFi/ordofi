/**
 * Per-send invoice for API keys. Anon wallet traffic has no one to bill.
 * Prepaid ETH (credited at the portal) is spent first; the rest is owed.
 */
import type { OrdoStore } from "@ordofi/store";

export function priceMicros(usd: number): number {
  return Math.max(0, Math.round(usd * 1_000_000));
}

export function canSend(store: OrdoStore | null, label: string, usd: number, enforce: boolean): boolean {
  if (!store) return true;
  return store.canChargeSend(label, priceMicros(usd), enforce);
}

export function chargeSend(store: OrdoStore | null, label: string, usd: number): void {
  if (!store || !label || label === "anon") return;
  try {
    store.chargeKeyedSend(label, priceMicros(usd));
  } catch (e) {
    console.warn(`gateway | billing charge failed for ${label}: ${(e as Error).message}`);
  }
}
