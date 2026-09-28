/** Leitor de CSV simples e tolerante: detecta ; , ou tab, aceita aspas e quebras de linha dentro de aspas. */
export function parseCsv(textIn) {
  const text = String(textIn || '').replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ';': (firstLine.match(/;/g) || []).length, ',': (firstLine.match(/,/g) || []).length, '\t': (firstLine.match(/\t/g) || []).length };
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
  const rows = []; let row = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

export function csvEscape(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // texto que começa com = + - @ vira fórmula no Excel: neutraliza (números negativos continuam números)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-?[\d.,]+$/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Gera CSV com ; (abre direto no Excel/Google Planilhas em português). */
export function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(';')];
  for (const r of rows) lines.push(r.map(csvEscape).join(';'));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
