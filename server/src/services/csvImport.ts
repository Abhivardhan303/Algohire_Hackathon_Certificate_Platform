import { parse } from 'csv-parse/sync';
import { z } from 'zod';

export interface ImportRow {
  rowNumber: number;
  name: string;
  identifier: string;
  course: string;
  phone: string;
}

export interface RowError {
  row: number;
  field: string;
  message: string;
}

export interface ParseResult {
  rows: ImportRow[];
  errors: RowError[];
}

const HEADER_MAP: Record<string, keyof Omit<ImportRow, 'rowNumber'>> = {
  name: 'name',
  candidate_name: 'name',
  candidate: 'name',
  full_name: 'name',
  identifier: 'identifier',
  candidate_identifier: 'identifier',
  candidate_id: 'identifier',
  id: 'identifier',
  course: 'course',
  course_name: 'course',
  skill: 'course',
  phone: 'phone',
  phone_number: 'phone',
  mobile: 'phone',
  mobile_number: 'phone',
};

const requiredFields: Array<keyof Omit<ImportRow, 'rowNumber'>> = ['name', 'identifier', 'course', 'phone'];

const rowSchema = z.object({
  name: z.string().trim().min(2, 'Candidate name must be at least 2 characters'),
  identifier: z
    .string()
    .trim()
    .min(3, 'Candidate identifier must be at least 3 characters')
    .max(64, 'Candidate identifier is too long'),
  course: z.string().trim().min(2, 'Course / skill must be at least 2 characters'),
  phone: z.string().trim().min(1, 'Phone number is required'),
});

export function normaliseHeader(header: string): string {
  return header
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

export function normalisePhone(input: string): string | null {
  const cleaned = input.replace(/[\s().-]/g, '');
  if (!/^\+?\d{8,15}$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Parses and validates ALL rows. Nothing is persisted here: the caller must abort the
 * whole import when `errors.length > 0` so a partial batch can never be saved.
 */
export function parseCandidateCsv(content: string | Buffer): ParseResult {
  let records: Record<string, string>[];
  try {
    records = parse(content, {
      columns: (headers: string[]) => headers.map((h) => HEADER_MAP[normaliseHeader(h)] ?? normaliseHeader(h)),
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    }) as Record<string, string>[];
  } catch (error) {
    return { rows: [], errors: [{ row: 0, field: 'file', message: `Could not parse CSV: ${(error as Error).message}` }] };
  }

  if (!records.length) {
    return { rows: [], errors: [{ row: 0, field: 'file', message: 'The file contains no candidate rows' }] };
  }

  const errors: RowError[] = [];
  const rows: ImportRow[] = [];
  const seen = new Map<string, number>();

  const missingHeaders = requiredFields.filter((f) => !(f in (records[0] ?? {})));
  if (missingHeaders.length) {
    return {
      rows: [],
      errors: [
        {
          row: 1,
          field: 'header',
          message: `Missing required column(s): ${missingHeaders.join(', ')}. Expected headers: name, identifier, course, phone`,
        },
      ],
    };
  }

  records.forEach((record, index) => {
    // +2 because line 1 is the header and spreadsheets are 1-based.
    const rowNumber = index + 2;
    const candidate = {
      name: typeof record.name === 'string' ? record.name : '',
      identifier: typeof record.identifier === 'string' ? record.identifier : '',
      course: typeof record.course === 'string' ? record.course : '',
      phone: typeof record.phone === 'string' ? record.phone : '',
    };

    const parsed = rowSchema.safeParse(candidate);
    const fieldErrors: RowError[] = [];
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        fieldErrors.push({ row: rowNumber, field: String(issue.path[0] ?? 'row'), message: issue.message });
      }
    }

    const phone = normalisePhone(candidate.phone);
    const phoneSchemaFailed = !parsed.success && parsed.error.issues.some((issue) => issue.path[0] === 'phone');
    if (!phone && !phoneSchemaFailed) {
      fieldErrors.push({
        row: rowNumber,
        field: 'phone',
        message: 'Phone number must contain 8-15 digits (optional leading +)',
      });
    }

    if (fieldErrors.length > 0) {
      errors.push(...fieldErrors);
      return;
    }

    if (!parsed.success || !phone) return;

    const key = parsed.data.identifier.toLowerCase();
    const firstSeen = seen.get(key);
    if (firstSeen !== undefined) {
      errors.push({
        row: rowNumber,
        field: 'identifier',
        message: `Duplicate identifier "${parsed.data.identifier}" (also used on row ${firstSeen})`,
      });
      return;
    }
    seen.set(key, rowNumber);

    rows.push({ rowNumber, ...parsed.data, phone });
  });

  return { rows, errors };
}
