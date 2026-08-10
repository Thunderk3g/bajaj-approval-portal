import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';

const path = process.argv[2];
const wb = XLSX.read(readFileSync(path), { cellDates: true, sheets: ['Login Data', 'Manpower'] });

const login = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Login Data'], {
  defval: null,
});

function tally(rows: Record<string, unknown>[], column: string, limit = 12) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row[column] === null || row[column] === undefined ? '(null)' : String(row[column]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

console.log(`Login Data rows: ${login.length}`);
for (const col of ['Source', 'BASBA', 'BT', 'WROP', 'Status', 'AutoPay']) {
  console.log(`\n${col}:`);
  for (const [value, n] of tally(login, col)) console.log(`  ${String(n).padStart(6)}  ${value}`);
}

const manpower = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Manpower'], {
  defval: null,
});
console.log(`\nManpower rows: ${manpower.length}`);

// Does any TL_ID sit under more than one CCM_ID? If so a TL is not a simple
// child of one cluster head and "move the TL" is ambiguous.
const tlToCcm = new Map<string, Set<string>>();
for (const row of manpower) {
  const tl = row.TL_ID === null ? null : String(row.TL_ID);
  const ccm = row.CCM_ID === null ? null : String(row.CCM_ID);
  if (!tl || !ccm) continue;
  if (!tlToCcm.has(tl)) tlToCcm.set(tl, new Set());
  tlToCcm.get(tl)!.add(ccm);
}

const split = [...tlToCcm.entries()].filter(([, set]) => set.size > 1);
console.log(`distinct TL_IDs: ${tlToCcm.size}`);
console.log(`TL_IDs under MORE THAN ONE CCM: ${split.length}`);
for (const [tl, set] of split.slice(0, 10)) console.log(`  ${tl} -> ${[...set].join(', ')}`);
