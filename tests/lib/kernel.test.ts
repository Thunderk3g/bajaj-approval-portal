import { describe, expect, it } from 'vitest';
import {
  hasError,
  isSentinel,
  normalizeAutopay,
  normalizeIdentifier,
  normalizeMoney,
  normalizeSmId,
  normalizeStatus,
  normalizeString,
} from '@/lib/import/normalize';
import { excelSerialToISO, normalizeDate } from '@/lib/import/dates';
import { detectGaps, isAnomalous } from '@/lib/records/gaps';
import { CANONICAL_FIELDS, normalizeHeader } from '@/lib/fields';
import { formatMoney } from '@/lib/format';
import { parsePageParams } from '@/lib/pagination';
import { resolveStoredPath } from '@/lib/storage/paths';

describe('sentinel handling (spec 6.3)', () => {
  it('treats the literal hyphen as absence, not data', () => {
    // 86% of Source and 29% of AutoPay are "-" in the June file. Reading it as
    // data is what would make gap detection report nothing to fix.
    expect(isSentinel('-')).toBe(true);
    expect(normalizeString('-')).toBeNull();
  });

  it.each(['NA', 'N/A', 'null', '#N/A', '', '   '])('maps %j to null', (raw) => {
    expect(normalizeString(raw)).toBeNull();
  });

  it('keeps a genuine zero, which is a value and not a sentinel', () => {
    expect(isSentinel(0)).toBe(false);
    expect(normalizeString(0)).toBe('0');
  });

  it('trims and collapses internal whitespace', () => {
    expect(normalizeString('  Ravi   Kumar  ')).toBe('Ravi Kumar');
  });
});

describe('identifiers (spec 6.3)', () => {
  it('renders a large application number in full, never scientific notation', () => {
    const { value } = normalizeIdentifier(5920000001, 'appsNo');
    expect(value).toBe('5920000001');
    expect(value).not.toMatch(/[eE]/);
  });

  it('rejects display text that already lost precision', () => {
    const { value, issues } = normalizeIdentifier('5.92E+09', 'appsNo');
    expect(value).toBeNull();
    expect(hasError(issues)).toBe(true);
    expect(issues[0].code).toBe('ID_SCIENTIFIC_NOTATION');
  });

  it('rejects a fractional identifier rather than truncating it', () => {
    expect(hasError(normalizeIdentifier(1234.5, 'appsNo').issues)).toBe(true);
  });

  it('preserves a non-numeric identifier verbatim', () => {
    expect(normalizeIdentifier('C2CM21350', 'appsNo').value).toBe('C2CM21350');
  });
});

describe('SM_ID uppercasing (spec 6.3)', () => {
  it('collapses the mixed-case pair that splits a rep book in two', () => {
    // c2cm21350 and C2CM21350 are the same person; six such pairs exist.
    expect(normalizeSmId('c2cm21350').value).toBe('C2CM21350');
    expect(normalizeSmId(' C2CM21350 ').value).toBe('C2CM21350');
    expect(normalizeSmId('c2cm21350').value).toBe(normalizeSmId('C2CM21350').value);
  });

  it('maps the sentinel to null instead of the string "-"', () => {
    expect(normalizeSmId('-').value).toBeNull();
  });
});

describe('money (spec 3)', () => {
  it('returns a string so numeric(18,2) never round-trips through a float', () => {
    const { value } = normalizeMoney('4195.42', 'fp');
    expect(value).toBe('4195.42');
    expect(typeof value).toBe('string');
  });

  it('strips currency symbols and separators', () => {
    expect(normalizeMoney('₹ 1,20,000.50', 'anp').value).toBe('120000.50');
  });

  it('pads to two decimals', () => {
    expect(normalizeMoney('500', 'fp').value).toBe('500.00');
    expect(normalizeMoney('500.5', 'fp').value).toBe('500.50');
  });

  it('errors on a negative premium', () => {
    expect(hasError(normalizeMoney('-100', 'fp').issues)).toBe(true);
  });

  it('errors on text that is not an amount', () => {
    expect(hasError(normalizeMoney('pending', 'fp').issues)).toBe(true);
  });

  it('treats a blank as absent, not as zero', () => {
    expect(normalizeMoney('-', 'fp').value).toBeNull();
  });
});

describe('AutoPay vocabulary (spec 6.3)', () => {
  it.each([
    ['Y', 'Yes'],
    ['YES', 'Yes'],
    ['true', 'Yes'],
    ['1', 'Yes'],
    ['ACTIVE', 'Yes'],
    ['N', 'No'],
    ['no', 'No'],
    ['0', 'No'],
    ['INACTIVE', 'No'],
  ])('maps %j to %j', (raw, expected) => {
    expect(normalizeAutopay(raw).value).toBe(expected);
  });

  it('maps the sentinel to null rather than to "No"', () => {
    // The June file has no "No" at all — only Y, "-" and blank. Collapsing the
    // sentinel to "No" would silently assert 339 rows are confirmed non-AutoPay.
    expect(normalizeAutopay('-').value).toBeNull();
    expect(normalizeAutopay('').value).toBeNull();
  });

  it('warns but keeps an unknown token', () => {
    const { value, issues } = normalizeAutopay('Maybe');
    expect(value).toBe('Maybe');
    expect(hasError(issues)).toBe(false);
    expect(issues[0].severity).toBe('WARNING');
  });
});

describe('excel serial dates (spec 6.3, 13.2)', () => {
  it('matches the observed Issued_Date range exactly', () => {
    expect(excelSerialToISO(46176)).toBe('2026-06-03');
    expect(excelSerialToISO(46211)).toBe('2026-07-08');
  });

  it('absorbs the phantom 1900 leap day', () => {
    expect(excelSerialToISO(59)).toBe('1900-02-28');
    expect(excelSerialToISO(61)).toBe('1900-03-01');
  });

  it('reads a serial arriving as a numeric string', () => {
    expect(normalizeDate(46176).value).toBe('2026-06-03');
    expect(normalizeDate('46176').value).toBe('2026-06-03');
  });
});

describe('ambiguous date formats (spec 6.3)', () => {
  it('obeys the batch format instead of guessing', () => {
    // 03/04/2026 is 3 April or 4 March. Guessing corrupts data invisibly.
    expect(normalizeDate('03/04/2026', 'dd/MM/yyyy').value).toBe('2026-04-03');
    expect(normalizeDate('03/04/2026', 'MM/dd/yyyy').value).toBe('2026-03-04');
  });

  it('reads the ISO and dash forms', () => {
    expect(normalizeDate('2026-06-03', 'yyyy-MM-dd').value).toBe('2026-06-03');
    expect(normalizeDate('03-06-2026', 'dd-MM-yyyy').value).toBe('2026-06-03');
  });

  it('rejects a day that does not exist in that month', () => {
    expect(hasError(normalizeDate('31/04/2026', 'dd/MM/yyyy').issues)).toBe(true);
  });

  it('warns rather than errors when the date is implausible', () => {
    const { value, issues } = normalizeDate('01/01/1970', 'dd/MM/yyyy');
    expect(value).toBe('1970-01-01');
    expect(issues[0].severity).toBe('WARNING');
  });

  it.each(['-', '', '   ', 'NA', 'N/A', '#N/A', 'null'])(
    'treats %j as absent, raising no issue at all',
    (raw) => {
      // An unissued policy legitimately has no issuance date (section 6.4), and
      // the workbook writes "-" rather than leaving the cell empty. Raising an
      // ERROR here would mark all 105 blank-dated PENDING rows INVALID and block
      // them from commit — the most common correct state in the file, refused.
      const { value, issues } = normalizeDate(raw);
      expect(value).toBeNull();
      expect(issues).toHaveLength(0);
    },
  );

  it('still parses a numeric zero rather than treating it as absent', () => {
    // isSentinel returns false for numbers, so the serial path stays reachable.
    expect(normalizeDate(0).issues.some((i) => i.severity === 'ERROR')).toBe(true);
  });
});

describe('status-conditional gap detection (spec 6.4)', () => {
  const blank = { issuedDate: null, policyNo: null, autopay: null };

  it('reports every gap on an ISSUED row', () => {
    expect(detectGaps({ status: 'ISSUED', ...blank }).sort()).toEqual(
      ['MISSING_AUTOPAY', 'MISSING_ISSUED_DATE', 'MISSING_POLICY_NO'].sort(),
    );
  });

  it('reports nothing on a PENDING row', () => {
    // 105 blank issuance dates and 105 blank policy numbers live here. Counting
    // them would bury the 250 genuine gaps under 210 false ones.
    expect(detectGaps({ status: 'PENDING', ...blank })).toEqual([]);
  });

  it('reports nothing on a REJECTED row', () => {
    expect(detectGaps({ status: 'REJECTED', ...blank })).toEqual([]);
  });

  it('reports only the fields actually missing', () => {
    expect(
      detectGaps({ status: 'ISSUED', issuedDate: '2026-06-03', policyNo: '123', autopay: null }),
    ).toEqual(['MISSING_AUTOPAY']);
  });

  it('flags an ISSUED row with no policy number as an anomaly', () => {
    // Only three exist in the June file; section 6.4 wants them surfaced first.
    expect(isAnomalous({ status: 'ISSUED', issuedDate: '2026-06-03', policyNo: null, autopay: 'Yes' })).toBe(true);
    expect(isAnomalous({ status: 'PENDING', ...blank })).toBe(false);
  });

  it('is not fooled by lowercase or padded status text', () => {
    expect(detectGaps({ status: ' issued ', ...blank })).toHaveLength(3);
  });
});

describe('canonical field registry (spec 6.2)', () => {
  it('resolves the four renamed columns without admin intervention', () => {
    const find = (header: string) =>
      CANONICAL_FIELDS.find((f) => f.aliases.includes(normalizeHeader(header)))?.key;

    expect(find('ANP')).toBe('anp'); // requirement called it APE
    expect(find('APE')).toBe('anp');
    expect(find('FP')).toBe('fp'); // requirement called it FRP
    expect(find('FRP')).toBe('fp');
    expect(find('Issued_Date')).toBe('issuedDate'); // requirement said Issuance_Date
    expect(find('Issuance Date')).toBe('issuedDate');
  });

  it('normalizes punctuation and case out of a header', () => {
    expect(normalizeHeader('SM_ID')).toBe('smid');
    expect(normalizeHeader('sm id')).toBe('smid');
    expect(normalizeHeader('Sm.Id')).toBe('smid');
  });

  it('requires exactly Apps_No and SM_ID', () => {
    expect(CANONICAL_FIELDS.filter((f) => f.required).map((f) => f.key).sort()).toEqual([
      'appsNo',
      'smId',
    ]);
  });

  it('never assigns one alias to two fields', () => {
    const seen = new Map<string, string>();
    for (const field of CANONICAL_FIELDS) {
      for (const alias of field.aliases) {
        expect(seen.has(alias), `alias "${alias}" is claimed by ${seen.get(alias)} and ${field.key}`).toBe(false);
        seen.set(alias, field.key);
      }
    }
  });
});

describe('presentation helpers', () => {
  it('groups money without parsing it to a float', () => {
    expect(formatMoney('120000.50')).toBe('120,000.50');
    expect(formatMoney(null)).toBe('—');
  });

  it('normalizes status text before comparison', () => {
    expect(normalizeStatus(' issued ').value).toBe('ISSUED');
  });

  it('clamps a hand-edited page size instead of trusting it', () => {
    expect(parsePageParams({ pageSize: '100000' }).pageSize).toBe(25);
    expect(parsePageParams({ page: '-4' }).page).toBe(1);
    expect(parsePageParams({ page: '3', pageSize: '50' })).toEqual({
      page: 3,
      pageSize: 50,
      offset: 100,
    });
  });
});

describe('storage path safety (spec 4.4)', () => {
  it('refuses a stored path that climbs out of the storage root', () => {
    expect(() => resolveStoredPath('../../.env.local')).toThrow(/escapes/);
    expect(() => resolveStoredPath('proofs/../../../etc/passwd')).toThrow(/escapes/);
  });

  it('refuses an absolute path', () => {
    expect(() => resolveStoredPath('C:\\Windows\\System32\\config\\SAM')).toThrow();
  });

  it('accepts a well-formed relative path', () => {
    expect(resolveStoredPath('proofs/2026/07/abc.png')).toMatch(/storage/);
  });
});
