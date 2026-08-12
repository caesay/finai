/** Money always crosses the wire as integer minor units; format it only for display. */
export function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    signDisplay: 'auto',
  }).format(amountMinor / 100);
}

/** Parses "-12.34" or "12,34" into minor units. Returns null when unparseable. */
export function parseMoney(input: string): number | null {
  const normalized = input.replace(/[\s,]/g, (match) => (match === ',' ? '.' : ''));
  if (!/^-?\d*\.?\d*$/.test(normalized) || normalized === '' || normalized === '-') return null;

  return Math.round(Number(normalized) * 100);
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
