/**
 * Small RFC 4180 CSV reader.
 *
 * Written by hand rather than pulled in as a dependency because the job is
 * narrow: split a bank export into a header row and string cells. Everything
 * that interprets those cells lives in mapping.ts.
 */

export interface ParsedCsv {
  delimiter: string;
  headers: string[];
  rows: string[][];
}

const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'];

export function parseCsv(text: string): ParsedCsv {
  const cleaned = stripBom(text);
  const delimiter = detectDelimiter(cleaned);
  const records = readRecords(cleaned, delimiter);

  const headerRecord = records.shift() ?? [];
  const headers = headerRecord.map(
    (header, index) => header.trim() || `column ${String(index + 1)}`,
  );

  // Trailing newlines and separator lines produce empty records; drop them.
  const rows = records.filter((row) => row.some((cell) => cell.trim() !== ''));

  return { delimiter, headers, rows };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Picks the delimiter that yields the most columns on the header line. */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';

  let best = ',';
  let bestCount = 0;

  for (const candidate of CANDIDATE_DELIMITERS) {
    const count = countOutsideQuotes(firstLine, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }

  return best;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char === delimiter) count += 1;
  }

  return count;
}

function readRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      record.push(field);
      field = '';
    } else if (char === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return records;
}
