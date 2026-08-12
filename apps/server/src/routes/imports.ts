import type { CsvAnalysis, CsvImportResult, CsvMapping } from '@finai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { runAutomationsForTransaction } from '../automations/engine.js';
import { parseCsv } from '../import/csv.js';
import { applyMapping } from '../import/mapping.js';
import { suggestMapping } from '../import/suggest.js';
import { badRequest } from '../lib/errors.js';

/** How many converted rows the dialog previews. */
const PREVIEW_ROWS = 10;
const MAX_ROWS = 20_000;

const mappingSchema = z.object({
  dateColumn: z.string(),
  dateFormat: z.enum(['iso', 'dmy', 'mdy']),
  descriptionColumn: z.string(),
  amountMode: z.enum(['single', 'debit_credit']),
  amountColumn: z.string(),
  debitColumn: z.string(),
  creditColumn: z.string(),
  invertAmount: z.boolean(),
  notesColumn: z.string(),
  externalIdColumn: z.string(),
});

const csvSchema = z.string().min(1).max(20_000_000);

export async function importRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Parses the file and asks the assistant which column is which. This is the
   * only step that costs a Codex turn; preview and commit are mechanical.
   */
  app.post('/imports/analyze', async (request, reply) => {
    const { csv } = z.object({ csv: csvSchema }).parse(request.body);

    const parsed = parseCsv(csv);
    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      return badRequest(reply, 'That file has no header row and data rows');
    }
    if (parsed.rows.length > MAX_ROWS) {
      return badRequest(reply, `That file has more than ${String(MAX_ROWS)} rows`);
    }

    const suggestion = await suggestMapping(app.codex, app.config, parsed);

    const analysis: CsvAnalysis = {
      headers: parsed.headers,
      delimiter: parsed.delimiter,
      totalRows: parsed.rows.length,
      sampleRows: parsed.rows.slice(0, PREVIEW_ROWS),
      suggestion,
      preview: applyMapping(parsed, suggestion.mapping, PREVIEW_ROWS),
    };

    return analysis;
  });

  /** Re-runs the mechanical transform after the user edits the mapping. */
  app.post('/imports/preview', async (request, reply) => {
    const { csv, mapping } = z
      .object({ csv: csvSchema, mapping: mappingSchema })
      .parse(request.body);

    const parsed = parseCsv(csv);
    if (parsed.rows.length === 0) return badRequest(reply, 'That file has no data rows');

    return applyMapping(parsed, mapping, PREVIEW_ROWS);
  });

  app.post('/imports/commit', async (request, reply) => {
    const { csv, mapping, accountId } = z
      .object({ csv: csvSchema, mapping: mappingSchema, accountId: z.string().uuid() })
      .parse(request.body);

    const account = await app.repositories.accounts.get(accountId);
    if (!account) return badRequest(reply, 'Unknown account');

    const parsed = parseCsv(csv);
    const converted = applyMapping(parsed, mapping as CsvMapping);
    if (converted.rows.length === 0) {
      return badRequest(reply, 'No rows could be converted with this mapping');
    }

    const externalIds = converted.rows
      .map((row) => row.externalId)
      .filter((value): value is string => value !== null);
    const seen = await app.repositories.transactions.findExternalIds(accountId, externalIds);

    let imported = 0;
    let skipped = 0;

    for (const row of converted.rows) {
      if (row.externalId && seen.has(row.externalId)) {
        skipped += 1;
        continue;
      }

      const transaction = await app.repositories.transactions.create({
        accountId,
        postedAt: row.postedAt,
        description: row.description,
        amountMinor: row.amountMinor,
        notes: row.notes,
        externalId: row.externalId,
      });

      await runAutomationsForTransaction(
        {
          automations: app.repositories.automations,
          transactions: app.repositories.transactions,
          categories: app.repositories.categories,
          audit: app.repositories.audit,
          codex: app.codex,
          config: app.config,
          log: { warn: (context, message) => app.log.warn(context, message) },
        },
        transaction,
      );

      imported += 1;
    }

    await app.repositories.audit.record({
      actor: 'user',
      entity: 'account',
      entityId: accountId,
      action: 'update',
      summary: `Imported ${String(imported)} transactions from CSV into ${account.bank} — ${account.name}`,
    });

    const result: CsvImportResult = { imported, skipped, errors: converted.errors };
    return reply.status(201).send(result);
  });
}
