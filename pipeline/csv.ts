import { readFileSync } from 'node:fs';

/** Quote-aware CSV parser for the small metadata files (plays, players, scouting). */
export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function readCsv(path: string): Record<string, string>[] {
  const rows = parseCsvText(readFileSync(path, 'utf8'));
  const header = rows[0];
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length !== header.length) continue;
    const rec: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) rec[header[i]] = cells[i];
    out.push(rec);
  }
  return out;
}

/** 'NA' / empty -> null, otherwise Number. */
export function num(v: string | undefined): number | null {
  if (v === undefined || v === '' || v === 'NA') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
