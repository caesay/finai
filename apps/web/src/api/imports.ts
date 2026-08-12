import type { CsvAnalysis, CsvImportResult, CsvMapping, CsvPreview } from '@finai/shared';

import { apiFetch } from './client.js';

export const analyzeCsv = (csv: string): Promise<CsvAnalysis> =>
  apiFetch<CsvAnalysis>('/imports/analyze', { method: 'POST', body: JSON.stringify({ csv }) });

export const previewCsv = (csv: string, mapping: CsvMapping): Promise<CsvPreview> =>
  apiFetch<CsvPreview>('/imports/preview', {
    method: 'POST',
    body: JSON.stringify({ csv, mapping }),
  });

export const commitCsv = (
  csv: string,
  mapping: CsvMapping,
  accountId: string,
): Promise<CsvImportResult> =>
  apiFetch<CsvImportResult>('/imports/commit', {
    method: 'POST',
    body: JSON.stringify({ csv, mapping, accountId }),
  });
