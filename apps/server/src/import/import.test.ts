import type { CsvMapping } from '@finai/shared';
import { expect, test } from 'vitest';

import { parseCsv } from './csv.js';
import { applyMapping, parseAmount, parseDate } from './mapping.js';

function mapping(overrides: Partial<CsvMapping> = {}): CsvMapping {
  return {
    dateColumn: 'Date',
    dateFormat: 'iso',
    descriptionColumn: 'Description',
    amountMode: 'single',
    amountColumn: 'Amount',
    debitColumn: '',
    creditColumn: '',
    invertAmount: false,
    notesColumn: '',
    externalIdColumn: '',
    ...overrides,
  };
}

test('reads quoted fields, embedded separators and newlines', () => {
  const csv = parseCsv('Date,Description,Amount\n2026-08-01,"TESCO, LONDON","-12.34"\n');

  expect(csv.headers).toEqual(['Date', 'Description', 'Amount']);
  expect(csv.rows).toEqual([['2026-08-01', 'TESCO, LONDON', '-12.34']]);
});

test('handles doubled quotes and multi-line fields', () => {
  const csv = parseCsv('a,b\n"say ""hi""","line one\nline two"\n');

  expect(csv.rows[0]).toEqual(['say "hi"', 'line one\nline two']);
});

test('detects semicolon and tab separated files', () => {
  expect(parseCsv('Date;Description;Amount\n2026-08-01;Coffee;-3,50\n').delimiter).toBe(';');
  expect(parseCsv('Date\tDescription\tAmount\n2026-08-01\tCoffee\t-3.50\n').delimiter).toBe('\t');
});

test('strips a byte order mark from the first header', () => {
  expect(parseCsv('﻿Date,Amount\n2026-08-01,1\n').headers[0]).toBe('Date');
});

test('parseAmount reads the formats banks actually emit', () => {
  expect(parseAmount('-12.34')).toBe(-1234);
  expect(parseAmount('1,234.56')).toBe(123456);
  expect(parseAmount('1.234,56')).toBe(123456);
  expect(parseAmount('£1,234.56')).toBe(123456);
  expect(parseAmount('(12.34)')).toBe(-1234);
  expect(parseAmount('1,234')).toBe(123400);
  expect(parseAmount('')).toBeNull();
  expect(parseAmount('n/a')).toBeNull();
});

test('parseDate honours the chosen field order', () => {
  expect(parseDate('2026-08-01', 'iso')).toBe('2026-08-01');
  expect(parseDate('01/08/2026', 'dmy')).toBe('2026-08-01');
  expect(parseDate('08/01/2026', 'mdy')).toBe('2026-08-01');
  expect(parseDate('01-08-26', 'dmy')).toBe('2026-08-01');
  expect(parseDate('not a date', 'iso')).toBeNull();
  expect(parseDate('2026-13-01', 'iso')).toBeNull();
});

test('applies a single signed amount column', () => {
  const csv = parseCsv(
    'Date,Description,Amount\n2026-08-01,Coffee,-3.50\n2026-08-02,Salary,2500\n',
  );
  const preview = applyMapping(csv, mapping());

  expect(preview.rows.map((row) => row.amountMinor)).toEqual([-350, 250000]);
  expect(preview.validRows).toBe(2);
});

test('flips the sign when the file writes spending as positive', () => {
  const csv = parseCsv('Date,Description,Amount\n2026-08-01,Coffee,3.50\n');
  const preview = applyMapping(csv, mapping({ invertAmount: true }));

  expect(preview.rows[0]?.amountMinor).toBe(-350);
});

test('turns separate debit and credit columns into signed amounts', () => {
  const csv = parseCsv(
    'Date,Description,Out,In\n2026-08-01,Coffee,3.50,\n2026-08-02,Salary,,2500\n',
  );
  const preview = applyMapping(
    csv,
    mapping({
      amountMode: 'debit_credit',
      amountColumn: '',
      debitColumn: 'Out',
      creditColumn: 'In',
    }),
  );

  expect(preview.rows.map((row) => row.amountMinor)).toEqual([-350, 250000]);
});

test('ignores the flip flag when in and out columns are separate', () => {
  // Bank exports write "money out" as a positive number, so a model can end up
  // setting invertAmount as well; that must not double up on the sign.
  const csv = parseCsv(
    'Date,Description,Out,In\n2026-08-01,Coffee,3.50,\n2026-08-02,Salary,,2500\n',
  );
  const preview = applyMapping(
    csv,
    mapping({
      amountMode: 'debit_credit',
      amountColumn: '',
      debitColumn: 'Out',
      creditColumn: 'In',
      invertAmount: true,
    }),
  );

  expect(preview.rows.map((row) => row.amountMinor)).toEqual([-350, 250000]);
});

test('reports unreadable rows instead of importing them', () => {
  const csv = parseCsv(
    'Date,Description,Amount\nnope,Coffee,-3.50\n2026-08-02,,-1\n2026-08-03,Ok,-1\n',
  );
  const preview = applyMapping(csv, mapping());

  expect(preview.validRows).toBe(1);
  expect(preview.errors).toHaveLength(2);
  expect(preview.errors[0]?.message).toContain('date');
  expect(preview.errors[1]?.message).toContain('description');
});

test('limits the preview without affecting the valid row count', () => {
  const rows = Array.from(
    { length: 25 },
    (_unused, index) => `2026-08-${String(index + 1).padStart(2, '0')},Row ${String(index)},-1`,
  ).join('\n');

  const preview = applyMapping(parseCsv(`Date,Description,Amount\n${rows}\n`), mapping(), 10);

  expect(preview.rows).toHaveLength(10);
  expect(preview.validRows).toBe(25);
});

test('carries notes and the unique reference through when mapped', () => {
  const csv = parseCsv(
    'Date,Description,Amount,Memo,Ref\n2026-08-01,Coffee,-3.50,card 1234,abc-1\n',
  );
  const preview = applyMapping(csv, mapping({ notesColumn: 'Memo', externalIdColumn: 'Ref' }));

  expect(preview.rows[0]).toMatchObject({ notes: 'card 1234', externalId: 'abc-1' });
});

test('a column the mapping names but the file lacks is treated as absent', () => {
  const csv = parseCsv('Date,Description,Amount\n2026-08-01,Coffee,-3.50\n');
  const preview = applyMapping(csv, mapping({ notesColumn: 'Memo' }));

  expect(preview.rows[0]?.notes).toBeNull();
});
