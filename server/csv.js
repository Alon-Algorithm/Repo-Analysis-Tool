// server/csv.js
//
// Minimal RFC 4180 CSV reader/writer (no dependencies).
// Matches the reference exports: UTF-8, LF line endings, minimal quoting
// (a field is quoted only when it contains a comma, quote or line break).

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue; // tolerate CRLF
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const needsQuote = (s) => s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r');

export function toCsv(rows) {
  let out = '';
  for (const row of rows) {
    out +=
      row
        .map((value) => {
          const s = String(value);
          return needsQuote(s) ? `"${s.replaceAll('"', '""')}"` : s;
        })
        .join(',') + '\n';
  }
  return out;
}
