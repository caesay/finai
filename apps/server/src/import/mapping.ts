import type {
  CsvDateFormat,
  CsvMapping,
  CsvPreview,
  CsvPreviewRow,
  CsvReconciliation,
  CsvRowError,
} from '@finai/shared';

import type { ParsedCsv } from './csv.js';

/**
 * The mechanical half of an import: given a mapping, turn rows into
 * transaction fields. No model involvement, so the same file and mapping
 * always produce the same result, and a bad row is reported rather than
 * guessed at.
 */
export function applyMapping(csv: ParsedCsv, mapping: CsvMapping, limit?: number): CsvPreview {
  const index = columnIndexes(csv.headers, mapping);
  const converted: CsvPreviewRow[] = [];
  const errors: CsvRowError[] = [];

  for (const [position, cells] of csv.rows.entries()) {
    const rowNumber = position + 1;
    const row = convertRow(cells, index, mapping, rowNumber);

    if ('message' in row) {
      errors.push({ row: rowNumber, message: row.message });
      continue;
    }

    converted.push(row);
  }

  // Reconciliation always looks at the whole file, not just the preview, and
  // the adjustments it produces are part of what gets imported.
  const reconciliation = reconcile(converted);
  const rows = withAdjustments(converted);

  return {
    rows: limit === undefined ? rows : rows.slice(0, limit),
    errors,
    validRows: converted.length,
    reconciliation,
  };
}

/**
 * Returns the rows in the order they will be imported, with a balance
 * adjustment inserted wherever the statement's own balances and amounts
 * disagree.
 *
 * The bank's balance column is treated as the truth: if a row moves the balance
 * by more than its amount explains, something is missing or duplicated upstream,
 * and an adjustment carries the difference so the account still lands on the
 * figure the bank reported.
 */
export function withAdjustments(rows: CsvPreviewRow[]): CsvPreviewRow[] {
  const hasBalances = rows.some((row) => row.balanceMinor !== null);
  if (!hasBalances) return rows;

  const ordered = isNewestFirst(rows) ? [...rows].reverse() : rows;
  const result: CsvPreviewRow[] = [];
  let previousBalance: number | null = null;

  for (const row of ordered) {
    result.push(row);

    if (row.balanceMinor === null) continue;

    if (previousBalance !== null) {
      const gap = row.balanceMinor - previousBalance - row.amountMinor;
      if (gap !== 0) result.push(adjustment(row, gap));
    }

    previousBalance = row.balanceMinor;
  }

  return result;
}

function adjustment(after: CsvPreviewRow, amountMinor: number): CsvPreviewRow {
  return {
    row: after.row,
    postedAt: after.postedAt,
    description: 'Balance adjustment',
    amountMinor,
    notes: `Statement balance did not match the transactions around ${after.postedAt}`,
    // Deterministic, so re-importing the same statement does not stack up
    // duplicate adjustments.
    externalId: `adjustment:${after.postedAt}:${String(after.balanceMinor ?? 0)}`,
    balanceMinor: after.balanceMinor,
    kind: 'adjustment',
  };
}

/**
 * Walks the statement oldest-first and checks that each amount matches the step
 * between consecutive balances.
 *
 * Statements come in both orders, so the direction is taken from the dates. The
 * balance before the earliest row is what the account's opening balance has to
 * be for the derived balance to agree with the bank.
 */
export function reconcile(rows: CsvPreviewRow[]): CsvReconciliation {
  const withBalance = rows.filter(
    (row): row is CsvPreviewRow & { balanceMinor: number } => row.balanceMinor !== null,
  );

  if (withBalance.length === 0) {
    return {
      available: false,
      checked: 0,
      mismatches: 0,
      firstMismatch: null,
      impliedOpeningBalanceMinor: null,
      closingBalanceMinor: null,
    };
  }

  const ordered = isNewestFirst(withBalance) ? [...withBalance].reverse() : withBalance;
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first || !last) throw new Error('Unreachable: ordered statement rows are non-empty');

  let checked = 0;
  let mismatches = 0;
  let firstMismatch: CsvReconciliation['firstMismatch'] = null;

  for (let position = 1; position < ordered.length; position += 1) {
    const previous = ordered[position - 1];
    const current = ordered[position];
    if (!previous || !current) continue;

    checked += 1;
    const expected = current.balanceMinor - previous.balanceMinor;
    if (expected === current.amountMinor) continue;

    mismatches += 1;
    firstMismatch ??= {
      row: current.row,
      expectedMinor: expected,
      actualMinor: current.amountMinor,
    };
  }

  return {
    available: true,
    checked,
    mismatches,
    firstMismatch,
    impliedOpeningBalanceMinor: first.balanceMinor - first.amountMinor,
    closingBalanceMinor: last.balanceMinor,
  };
}

function isNewestFirst(rows: CsvPreviewRow[]): boolean {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return false;

  return last.postedAt < first.postedAt;
}

interface ColumnIndexes {
  date: number;
  description: number;
  amount: number;
  debit: number;
  credit: number;
  notes: number;
  externalId: number;
  balance: number;
  fee: number;
}

function columnIndexes(headers: string[], mapping: CsvMapping): ColumnIndexes {
  const find = (name: string): number =>
    name ? headers.findIndex((header) => header.toLowerCase() === name.toLowerCase()) : -1;

  return {
    date: find(mapping.dateColumn),
    description: find(mapping.descriptionColumn),
    amount: find(mapping.amountColumn),
    debit: find(mapping.debitColumn),
    credit: find(mapping.creditColumn),
    notes: find(mapping.notesColumn),
    externalId: find(mapping.externalIdColumn),
    balance: find(mapping.balanceColumn),
    fee: find(mapping.feeColumn),
  };
}

function convertRow(
  cells: string[],
  index: ColumnIndexes,
  mapping: CsvMapping,
  rowNumber: number,
): CsvPreviewRow | { message: string } {
  const rawDate = cell(cells, index.date);
  const postedAt = parseDate(rawDate, mapping.dateFormat);
  if (!postedAt) return { message: `Could not read a date from "${rawDate}"` };

  const description = cell(cells, index.description).trim();
  if (!description) return { message: 'Row has no description' };

  const amount = readAmount(cells, index, mapping);
  if (amount === null) return { message: 'Row has no readable amount' };

  // Separate debit and credit columns already say which direction money moved,
  // so the flip only applies to a single signed column. Without this guard a
  // mapping that sets both lands every row with the wrong sign.
  const invert = mapping.invertAmount && mapping.amountMode === 'single';
  const signed = invert ? -amount : amount;

  // A separately billed fee left the account too, so folding it in keeps both
  // the spend and the running balance honest.
  const fee = index.fee === -1 ? null : parseAmount(cell(cells, index.fee));
  const amountMinor = fee === null ? signed : signed - Math.abs(fee);
  const balanceMinor = index.balance === -1 ? null : parseAmount(cell(cells, index.balance));
  const reference = index.externalId === -1 ? '' : cell(cells, index.externalId).trim();

  return {
    row: rowNumber,
    postedAt,
    description,
    amountMinor,
    notes: index.notes === -1 ? null : cell(cells, index.notes).trim() || null,
    externalId: reference || syntheticReference(postedAt, amountMinor, balanceMinor),
    balanceMinor,
    kind: 'normal',
  };
}

/**
 * Many statements carry no per-row reference, which would make re-importing an
 * overlapping month duplicate everything. A running balance is enough to
 * identify a row within an account — no two rows can leave the account at the
 * same figure on the same day for the same amount — so it stands in as a key.
 *
 * Without a balance column there is nothing safe to key on: two identical
 * purchases on one day are genuinely two transactions, so rows stay unkeyed and
 * a re-import will duplicate them.
 */
function syntheticReference(
  postedAt: string,
  amountMinor: number,
  balanceMinor: number | null,
): string | null {
  if (balanceMinor === null) return null;
  return `row:${postedAt}:${String(amountMinor)}:${String(balanceMinor)}`;
}

function cell(cells: string[], index: number): string {
  return index === -1 ? '' : (cells[index] ?? '');
}

function readAmount(cells: string[], index: ColumnIndexes, mapping: CsvMapping): number | null {
  if (mapping.amountMode === 'debit_credit') {
    const debit = parseAmount(cell(cells, index.debit));
    const credit = parseAmount(cell(cells, index.credit));

    // Exactly one of the two columns carries a value on any given row.
    if (debit !== null && debit !== 0) return -Math.abs(debit);
    if (credit !== null && credit !== 0) return Math.abs(credit);
    return debit === null && credit === null ? null : 0;
  }

  return parseAmount(cell(cells, index.amount));
}

/**
 * Reads "1.234,56", "(12.34)", "£1,234.56" and friends into minor units.
 * The last separator in the string decides the decimal point.
 */
export function parseAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const negative = /^\(.*\)$/.test(trimmed) || trimmed.includes('-');
  const digitsOnly = trimmed.replace(/[^\d.,]/g, '');
  if (digitsOnly === '') return null;

  const lastComma = digitsOnly.lastIndexOf(',');
  const lastDot = digitsOnly.lastIndexOf('.');
  const decimalAt = Math.max(lastComma, lastDot);

  let whole = digitsOnly;
  let fraction = '';

  if (decimalAt !== -1) {
    const tail = digitsOnly.slice(decimalAt + 1);
    // Three trailing digits after the final separator means it was a thousands
    // separator, not a decimal point.
    if (tail.length <= 2) {
      whole = digitsOnly.slice(0, decimalAt);
      fraction = tail;
    }
  }

  const value = Number(`${whole.replace(/[.,]/g, '') || '0'}.${fraction.padEnd(2, '0')}`);
  if (Number.isNaN(value)) return null;

  return Math.round(value * 100) * (negative ? -1 : 1);
}

/** Returns an ISO date (YYYY-MM-DD) or null. */
export function parseDate(raw: string, format: CsvDateFormat): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const parts = trimmed.split(/[^\d]+/).filter((part) => part !== '');
  if (parts.length < 3) return null;

  const [first, second, third] = parts as [string, string, string];

  let year: string;
  let month: string;
  let day: string;

  if (format === 'iso' || first.length === 4) {
    [year, month, day] = [first, second, third];
  } else if (format === 'mdy') {
    [month, day, year] = [first, second, third];
  } else {
    [day, month, year] = [first, second, third];
  }

  if (year.length === 2) year = `20${year}`;
  if (year.length !== 4) return null;

  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return null;

  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}
