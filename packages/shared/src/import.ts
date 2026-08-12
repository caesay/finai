/**
 * CSV import contracts.
 *
 * The assistant's only job is producing the mapping below. Turning rows into
 * transactions is done mechanically from that mapping, so an import is
 * reproducible and reviewable rather than a model rewriting your data.
 */

export type CsvDateFormat = 'iso' | 'dmy' | 'mdy';

export type CsvAmountMode = 'single' | 'debit_credit';

export interface CsvMapping {
  dateColumn: string;
  dateFormat: CsvDateFormat;
  descriptionColumn: string;
  amountMode: CsvAmountMode;
  /** Used when amountMode is 'single'. */
  amountColumn: string;
  /** Used when amountMode is 'debit_credit'; debits become negative amounts. */
  debitColumn: string;
  creditColumn: string;
  /** Flips the sign, for exports that write spending as a positive number. */
  invertAmount: boolean;
  /** Empty string means "no column". */
  notesColumn: string;
  externalIdColumn: string;
}

/** What the assistant returned, alongside the mapping it proposed. */
export interface CsvMappingSuggestion {
  mapping: CsvMapping;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

export interface CsvRowError {
  /** 1-based index into the data rows, ignoring the header. */
  row: number;
  message: string;
}

/** A row converted by the mechanical transform, ready to preview or import. */
export interface CsvPreviewRow {
  row: number;
  postedAt: string;
  description: string;
  amountMinor: number;
  notes: string | null;
  externalId: string | null;
}

export interface CsvAnalysis {
  headers: string[];
  delimiter: string;
  totalRows: number;
  /** The raw first rows, for showing what the file actually contains. */
  sampleRows: string[][];
  suggestion: CsvMappingSuggestion;
  preview: CsvPreview;
}

export interface CsvPreview {
  rows: CsvPreviewRow[];
  errors: CsvRowError[];
  /** Rows that converted cleanly across the whole file, not just the preview. */
  validRows: number;
}

export interface CsvImportResult {
  imported: number;
  skipped: number;
  errors: CsvRowError[];
}
