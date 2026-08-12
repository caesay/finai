import type {
  CsvDateFormat,
  CsvMapping,
  CsvPreview,
  CsvPreviewRow,
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
  const rows: CsvPreviewRow[] = [];
  const errors: CsvRowError[] = [];
  let validRows = 0;

  for (const [position, cells] of csv.rows.entries()) {
    const rowNumber = position + 1;
    const converted = convertRow(cells, index, mapping, rowNumber);

    if ('message' in converted) {
      errors.push({ row: rowNumber, message: converted.message });
      continue;
    }

    validRows += 1;
    if (limit === undefined || rows.length < limit) rows.push(converted);
  }

  return { rows, errors, validRows };
}

interface ColumnIndexes {
  date: number;
  description: number;
  amount: number;
  debit: number;
  credit: number;
  notes: number;
  externalId: number;
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

  return {
    row: rowNumber,
    postedAt,
    description,
    amountMinor: invert ? -amount : amount,
    notes: index.notes === -1 ? null : cell(cells, index.notes).trim() || null,
    externalId: index.externalId === -1 ? null : cell(cells, index.externalId).trim() || null,
  };
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
