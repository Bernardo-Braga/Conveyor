import type { LedgerClient } from '../http/ledgerClient.ts';
import type { SettingsStore } from '../settings/store.ts';

const RATE_URL = 'https://api.frankfurter.dev/v1/latest?base=CNY&symbols=USD';

/** The optional daily CNY rate: one request per calendar day, cached in settings. */
export async function usdPerCnyToday(ledger: LedgerClient, settings: SettingsStore, jobId: number | null = null, today = new Date().toISOString().slice(0, 10)): Promise<number | null> {
  const cached = settings.get('rates');
  if (cached.fetchedOn === today && cached.usdPerCny) return cached.usdPerCny;
  try {
    const res = await ledger.fetch({ service: 'other', purpose: 'cny_rate', jobId }, RATE_URL, { headers: { accept: 'application/json' } }, { timeoutMs: 15_000 });
    if (!res.ok) return cached.usdPerCny;
    const body = (await res.json()) as { rates?: { USD?: number } };
    const rate = body.rates?.USD;
    if (typeof rate !== 'number' || !(rate > 0)) return cached.usdPerCny;
    settings.set('rates', { usdPerCny: rate, fetchedOn: today });
    return rate;
  } catch {
    return cached.usdPerCny;
  }
}
