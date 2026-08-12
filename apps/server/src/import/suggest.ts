import type { CsvMapping, CsvMappingSuggestion } from '@finai/shared';
import type { Codex } from '@openai/codex-sdk';

import { threadOptions } from '../codex/client.js';
import type { Config } from '../config.js';
import type { ParsedCsv } from './csv.js';

/** How long the assistant may spend proposing a mapping. */
const TIMEOUT_MS = 90_000;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    dateColumn: { type: 'string', description: 'Header of the column holding the date.' },
    dateFormat: {
      type: 'string',
      enum: ['iso', 'dmy', 'mdy'],
      description: 'iso for 2026-08-01, dmy for 01/08/2026, mdy for 08/01/2026.',
    },
    descriptionColumn: { type: 'string' },
    amountMode: {
      type: 'string',
      enum: ['single', 'debit_credit'],
      description: 'single when one column holds signed amounts.',
    },
    amountColumn: { type: 'string', description: 'Empty string when amountMode is debit_credit.' },
    debitColumn: { type: 'string', description: 'Empty string when amountMode is single.' },
    creditColumn: { type: 'string', description: 'Empty string when amountMode is single.' },
    invertAmount: {
      type: 'boolean',
      description:
        'Only meaningful when amountMode is single: true when that one column writes spending as a positive number. Always false for debit_credit.',
    },
    notesColumn: { type: 'string', description: 'Empty string when there is nothing suitable.' },
    externalIdColumn: {
      type: 'string',
      description: 'A per-row unique reference, if the file has one. Empty string otherwise.',
    },
    balanceColumn: {
      type: 'string',
      description: 'Running account balance after each row, if present. Empty string otherwise.',
    },
    feeColumn: {
      type: 'string',
      description:
        'A fee billed separately from the amount, if the file has one. Empty string otherwise.',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string', description: 'One or two sentences on how the columns were read.' },
  },
  required: [
    'dateColumn',
    'dateFormat',
    'descriptionColumn',
    'amountMode',
    'amountColumn',
    'debitColumn',
    'creditColumn',
    'invertAmount',
    'notesColumn',
    'externalIdColumn',
    'balanceColumn',
    'feeColumn',
    'confidence',
    'reason',
  ],
  additionalProperties: false,
};

/**
 * Asks Codex which CSV column is which. The model never sees or produces the
 * imported rows — it only names columns, and the mechanical transform in
 * mapping.ts does the conversion.
 */
export async function suggestMapping(
  codex: Codex,
  config: Config,
  csv: ParsedCsv,
): Promise<CsvMappingSuggestion> {
  const thread = codex.startThread(threadOptions(config));

  const sample = csv.rows.slice(0, 8);
  const input = [
    'Map the columns of a bank statement CSV onto a transaction record.',
    '',
    `Columns: ${csv.headers.map((header) => JSON.stringify(header)).join(', ')}`,
    '',
    'First rows:',
    sample.map((row) => row.map((value) => JSON.stringify(value)).join(', ')).join('\n'),
    '',
    'Rules:',
    '- Column names in your answer must match the list above exactly.',
    '- Money leaving the account must end up negative.',
    '- Use debit_credit when separate columns hold money out and money in. That',
    '  mode already knows which direction each column means, so invertAmount',
    '  must be false there.',
    '- With a single column, set invertAmount only when that column writes',
    '  spending as a positive number.',
    '- Map balanceColumn when the file carries a running account balance, and',
    '  feeColumn when a fee is billed separately from the amount.',
    '- Return an empty string for any column that does not exist in this file.',
    '',
    'Answer only with the requested JSON. Do not run any commands.',
  ].join('\n');

  const turn = await thread.run(input, {
    outputSchema: OUTPUT_SCHEMA,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  return toSuggestion(turn.finalResponse, csv.headers);
}

function toSuggestion(response: string, headers: string[]): CsvMappingSuggestion {
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(response) as Record<string, unknown>;
  } catch {
    return {
      mapping: emptyMapping(),
      confidence: 'low',
      reason: 'The assistant returned no usable mapping.',
    };
  }

  // A hallucinated column name is dropped rather than trusted; the user picks
  // it from the dropdown instead.
  const column = (value: unknown): string => {
    const name = typeof value === 'string' ? value.trim() : '';
    const match = headers.find((header) => header.toLowerCase() === name.toLowerCase());
    return match ?? '';
  };

  const mapping: CsvMapping = {
    dateColumn: column(parsed.dateColumn),
    dateFormat:
      parsed.dateFormat === 'dmy' || parsed.dateFormat === 'mdy' ? parsed.dateFormat : 'iso',
    descriptionColumn: column(parsed.descriptionColumn),
    amountMode: parsed.amountMode === 'debit_credit' ? 'debit_credit' : 'single',
    amountColumn: column(parsed.amountColumn),
    debitColumn: column(parsed.debitColumn),
    creditColumn: column(parsed.creditColumn),
    invertAmount: parsed.invertAmount === true,
    notesColumn: column(parsed.notesColumn),
    externalIdColumn: column(parsed.externalIdColumn),
    balanceColumn: column(parsed.balanceColumn),
    feeColumn: column(parsed.feeColumn),
  };

  return {
    mapping,
    confidence:
      parsed.confidence === 'high' || parsed.confidence === 'medium' ? parsed.confidence : 'low',
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };
}

export function emptyMapping(): CsvMapping {
  return {
    dateColumn: '',
    dateFormat: 'iso',
    descriptionColumn: '',
    amountMode: 'single',
    amountColumn: '',
    debitColumn: '',
    creditColumn: '',
    invertAmount: false,
    notesColumn: '',
    externalIdColumn: '',
    balanceColumn: '',
    feeColumn: '',
  };
}
