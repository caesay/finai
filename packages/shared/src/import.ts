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
  /**
   * Running account balance after each row, when the export has one. Used to
   * anchor the account's opening balance and to check the mapping — it is
   * never stored per transaction.
   */
  balanceColumn: string;
  /**
   * A fee charged on top of the amount, as some exports bill it separately.
   * It is folded into the transaction amount so the running balance reconciles.
   */
  feeColumn: string;
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
  /** Statement balance after this row, when the file carries one. */
  balanceMinor: number | null;
  /**
   * 'adjustment' rows are not in the file: the import inserts them where the
   * statement's balances and amounts disagree, so the running balance still
   * lands on the bank's figure.
   */
  kind: 'normal' | 'adjustment';
}

/**
 * What the statement's balance column says about the import.
 *
 * Every row's amount should equal the step between consecutive balances. When
 * they disagree the mapping is usually wrong — an inverted sign, the wrong
 * amount column, or a fee column that has not been accounted for — so this is
 * a far stronger check on the mapping than reading ten preview rows.
 */
export interface CsvReconciliation {
  available: boolean;
  /** Rows whose amount could be compared against the previous row's balance. */
  checked: number;
  /** How many balance adjustments the import will insert. */
  mismatches: number;
  firstMismatch: { row: number; expectedMinor: number; actualMinor: number } | null;
  /** Balance before the earliest row: what the account's opening balance should be. */
  impliedOpeningBalanceMinor: number | null;
  /** Balance after the latest row. */
  closingBalanceMinor: number | null;
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
  reconciliation: CsvReconciliation;
}

export interface CsvImportResult {
  imported: number;
  skipped: number;
  /** Balance adjustments inserted to make the statement reconcile. */
  adjustments: number;
  errors: CsvRowError[];
  /** Set when the import anchored the account's opening balance. */
  openingBalanceMinor: number | null;
}
