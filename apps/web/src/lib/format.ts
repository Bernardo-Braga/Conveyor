/** Money is stored in minor units. Only the UI formats currency. */
export function formatMoney(minor: number, currency = 'USD', locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 100);
}

export function formatTime(iso: string | null | undefined, locale = 'en-GB'): string {
  if (!iso) return '';
  const d = new Date(iso);
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d);
}

export function formatDateTime(iso: string | null | undefined, locale = 'en-GB'): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** "importing" → "Importing", "needs_attention" → "Needs attention". */
export function sentence(s: string): string {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
