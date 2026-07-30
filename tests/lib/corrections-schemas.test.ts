import { describe, expect, it } from 'vitest';
import {
  ISSUED_DATE_MIN,
  correctionSubmitSchema,
  isPlausibleIssuedDate,
  issuedDateMax,
  normalizeProposedValue,
  targetFieldFor,
} from '@/lib/corrections/schemas';

/** The first error message recorded against a field, for readable assertions. */
function errorFor(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }, field: string) {
  return result.error?.issues.find((i) => i.path.join('.') === field)?.message;
}

const VALID_APPS_NO = '6167509575';

describe('category discrimination (spec 7.1)', () => {
  it('routes each category to the field the registry says it owns', () => {
    const autopay = correctionSubmitSchema.parse({
      category: 'AUTOPAY',
      appsNo: VALID_APPS_NO,
      proposedValue: 'Yes',
    });
    expect(targetFieldFor(autopay)).toBe('autopay');

    const mapping = correctionSubmitSchema.parse({
      category: 'MAPPING',
      direction: 'CLAIM_IN',
      appsNo: VALID_APPS_NO,
      proposedValue: 'C2CM21350',
    });
    expect(targetFieldFor(mapping)).toBe('smId');

    const issuance = correctionSubmitSchema.parse({
      category: 'ISSUANCE_DATE',
      appsNo: VALID_APPS_NO,
      proposedValue: '2026-06-03',
    });
    expect(targetFieldFor(issuance)).toBe('issuedDate');
  });

  it('rejects a category that is not one of the four', () => {
    const result = correctionSubmitSchema.safeParse({
      category: 'PREMIUM',
      appsNo: VALID_APPS_NO,
      proposedValue: '100',
    });
    expect(result.success).toBe(false);
  });

  it('requires an application number', () => {
    const result = correctionSubmitSchema.safeParse({
      category: 'AUTOPAY',
      appsNo: '   ',
      proposedValue: 'Yes',
    });
    expect(result.success).toBe(false);
    expect(errorFor(result, 'appsNo')).toMatch(/application number/i);
  });
});

describe('AUTOPAY branch (spec 7.1)', () => {
  it.each(['Yes', 'No'])('accepts %s', (value) => {
    const parsed = correctionSubmitSchema.parse({
      category: 'AUTOPAY',
      appsNo: VALID_APPS_NO,
      proposedValue: value,
    });
    expect(parsed.proposedValue).toBe(value);
  });

  it('accepts the importer vocabulary and stores the canonical form', () => {
    // A correction must never store a spelling the importer would not have
    // produced, so `y` becomes `Yes` rather than being refused or kept raw.
    for (const [raw, expected] of [
      ['y', 'Yes'],
      ['YES', 'Yes'],
      ['n', 'No'],
      ['FALSE', 'No'],
    ] as const) {
      const parsed = correctionSubmitSchema.parse({
        category: 'AUTOPAY',
        appsNo: VALID_APPS_NO,
        proposedValue: raw,
      });
      expect(parsed.proposedValue).toBe(expected);
    }
  });

  it.each(['Maybe', 'Pending', '-', '', 'Y E S'])(
    'rejects %j, which is outside the Yes/No vocabulary',
    (value) => {
      const result = correctionSubmitSchema.safeParse({
        category: 'AUTOPAY',
        appsNo: VALID_APPS_NO,
        proposedValue: value,
      });
      expect(result.success).toBe(false);
      expect(errorFor(result, 'proposedValue')).toMatch(/Yes or No/);
    },
  );
});

describe('MAPPING branch (spec 7.1, 7.2)', () => {
  it('uppercases the SM_ID so a claim cannot split a rep book in two', () => {
    const parsed = correctionSubmitSchema.parse({
      category: 'MAPPING',
      direction: 'CLAIM_IN',
      appsNo: VALID_APPS_NO,
      proposedValue: ' c2cm21350 ',
    });
    expect(parsed.proposedValue).toBe('C2CM21350');
  });

  it('does not accept an SM name — that is resolved from the roster at approval', () => {
    const parsed = correctionSubmitSchema.parse({
      category: 'MAPPING',
      direction: 'CLAIM_IN',
      appsNo: VALID_APPS_NO,
      proposedValue: 'C2CM21350',
      smName: 'Ravi Kumar',
    });
    expect(parsed).not.toHaveProperty('smName');
  });

  it('rejects a blank SM_ID', () => {
    const result = correctionSubmitSchema.safeParse({
      category: 'MAPPING',
      direction: 'CLAIM_IN',
      appsNo: VALID_APPS_NO,
      proposedValue: '-',
    });
    expect(result.success).toBe(false);
  });

  /*
   * Direction — 2026-07-29 spec section 2.
   *
   * The branch cannot check what the two directions actually differ on: a claim
   * pins the destination to the submitter's own SM_ID and a transfer requires
   * it to be someone else's and on the roster, and both of those need the
   * session or the database. What the schema owns is that the choice was made
   * at all, and that it is one of the two.
   */
  it('refuses a mapping request that does not say which way the sale moves', () => {
    const result = correctionSubmitSchema.safeParse({
      category: 'MAPPING',
      appsNo: VALID_APPS_NO,
      proposedValue: 'C2CM21350',
    });
    expect(result.success).toBe(false);
    expect(errorFor(result, 'direction')).toMatch(/claiming this sale or transferring it out/i);
  });

  it('refuses a direction that is neither of the two', () => {
    const result = correctionSubmitSchema.safeParse({
      category: 'MAPPING',
      direction: 'SIDEWAYS',
      appsNo: VALID_APPS_NO,
      proposedValue: 'C2CM21350',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a transfer out and uppercases the rep it names', () => {
    const parsed = correctionSubmitSchema.parse({
      category: 'MAPPING',
      direction: 'TRANSFER_OUT',
      appsNo: VALID_APPS_NO,
      proposedValue: ' c2cm21350 ',
    });
    expect(parsed.proposedValue).toBe('C2CM21350');
    expect(parsed).toMatchObject({ direction: 'TRANSFER_OUT' });
  });

  it('ignores a direction on a category that has no use for one', () => {
    const parsed = correctionSubmitSchema.parse({
      category: 'AUTOPAY',
      direction: 'TRANSFER_OUT',
      appsNo: VALID_APPS_NO,
      proposedValue: 'Yes',
    });
    // Stripped rather than carried through. The service writes what the union
    // returns, and `correction_direction_iff_mapping` rejects a direction on an
    // AUTOPAY row — so a stray form field must not survive parsing.
    expect(parsed).not.toHaveProperty('direction');
  });
});

describe('OTHERS may no longer target smId (2026-07-29 spec 9)', () => {
  /*
   * This was a live hole, not a hypothetical. An OTHERS request naming smId
   * reaches the apply path with category !== 'MAPPING', so the mapping branch
   * is skipped: sm_id is rewritten while sm_name keeps the previous rep's name,
   * changedFields records one column instead of two, and neither rep is told.
   * It was the only way to push a sale out before TRANSFER_OUT existed.
   */
  it('refuses smId, which now has a category of its own', () => {
    const result = correctionSubmitSchema.safeParse({
      category: 'OTHERS',
      appsNo: VALID_APPS_NO,
      fieldName: 'smId',
      proposedValue: 'C2CM21350',
      description: 'Should have been Ravi.',
    });
    expect(result.success).toBe(false);
    expect(errorFor(result, 'fieldName')).toMatch(/not a field a correction can change/i);
  });

  it('still refuses appsNo, which has no category at all', () => {
    const result = correctionSubmitSchema.safeParse({
      category: 'OTHERS',
      appsNo: VALID_APPS_NO,
      fieldName: 'appsNo',
      proposedValue: '6167509999',
      description: 'Typo in the application number.',
    });
    expect(result.success).toBe(false);
  });

  it('still accepts an ordinary field', () => {
    const result = correctionSubmitSchema.safeParse({
      category: 'OTHERS',
      appsNo: VALID_APPS_NO,
      fieldName: 'clientName',
      proposedValue: 'Meera Nair',
      description: 'Spelled wrong in the source file.',
    });
    expect(result.success).toBe(true);
  });
});

describe('ISSUANCE_DATE branch (spec 7.1)', () => {
  it('accepts an ISO date inside the plausible range', () => {
    const parsed = correctionSubmitSchema.parse({
      category: 'ISSUANCE_DATE',
      appsNo: VALID_APPS_NO,
      proposedValue: '2026-06-03',
    });
    expect(parsed.proposedValue).toBe('2026-06-03');
  });

  it.each(['1989-12-31', '2099-01-01', 'yesterday', '03/04/2026'])(
    'rejects %j',
    (value) => {
      const result = correctionSubmitSchema.safeParse({
        category: 'ISSUANCE_DATE',
        appsNo: VALID_APPS_NO,
        proposedValue: value,
      });
      expect(result.success).toBe(false);
    },
  );

  it('allows one day past today so an IST evening is not called the future', () => {
    const now = new Date('2026-07-27T19:00:00Z');
    expect(issuedDateMax(now)).toBe('2026-07-28');
    expect(isPlausibleIssuedDate('2026-07-28', now)).toBe(true);
    expect(isPlausibleIssuedDate('2026-07-29', now)).toBe(false);
    expect(isPlausibleIssuedDate(ISSUED_DATE_MIN, now)).toBe(true);
  });
});

describe('AGENT_ID branch', () => {
  // The three codes that actually appear in the June `Businesses Dashboard`
  // workbook: two purely numeric, one alphanumeric, all ten characters.
  const REAL_CODES = ['3000000007', '59L0000000', '2000003060'];

  it.each(REAL_CODES)('accepts %j and targets agent_id', (code) => {
    const parsed = correctionSubmitSchema.parse({
      category: 'AGENT_ID',
      appsNo: VALID_APPS_NO,
      proposedValue: `  ${code}  `,
    });
    expect(parsed.proposedValue).toBe(code);
    // Read out of CATEGORY_FIELDS, never off the payload — the category is the
    // part of a request the approval path can trust.
    expect(targetFieldFor(parsed)).toBe('agentId');
  });

  it.each(['', '   ', '-', 'N/A'])('refuses %j as an agent code', (value) => {
    // The last two are the source workbook's sentinels for "no value".
    // Accepting them would let a correction write the literal text the importer
    // exists to turn into NULL.
    const result = correctionSubmitSchema.safeParse({
      category: 'AGENT_ID',
      appsNo: VALID_APPS_NO,
      proposedValue: value,
    });
    expect(result.success).toBe(false);
  });

  it('refuses a code that already lost its digits to scientific notation', () => {
    // The codes are ten-digit numbers that live in Excel, so this is the
    // realistic corruption, not a hypothetical one. Expanding `3.0E+09` would
    // invent seven digits and store a code nobody has.
    const result = correctionSubmitSchema.safeParse({
      category: 'AGENT_ID',
      appsNo: VALID_APPS_NO,
      proposedValue: '3.0E+09',
    });
    expect(result.success).toBe(false);
  });

  it('caps the length, since nothing downstream truncates', () => {
    const result = correctionSubmitSchema.safeParse({
      category: 'AGENT_ID',
      appsNo: VALID_APPS_NO,
      proposedValue: 'A'.repeat(65),
    });
    expect(result.success).toBe(false);
  });

  it('needs no description', () => {
    // Unlike OTHERS, the category already names the field, so there is nothing
    // a description would disambiguate.
    expect(
      correctionSubmitSchema.safeParse({
        category: 'AGENT_ID',
        appsNo: VALID_APPS_NO,
        proposedValue: 'AG-2002',
      }).success,
    ).toBe(true);
  });

  it('takes no direction — that belongs to MAPPING', () => {
    const parsed = correctionSubmitSchema.parse({
      category: 'AGENT_ID',
      appsNo: VALID_APPS_NO,
      proposedValue: 'AG-2002',
      direction: 'CLAIM_IN',
    });
    // Stripped by the branch rather than carried through, so the service never
    // has one to stamp on the row — `correction_direction_iff_mapping` is the
    // backstop, this is what stops it ever being reached.
    expect('direction' in parsed).toBe(false);
  });
});

describe('OTHERS branch (spec 7.1) — the three-layer requiredness rule', () => {
  it('accepts a named field with a description', () => {
    const parsed = correctionSubmitSchema.parse({
      category: 'OTHERS',
      appsNo: VALID_APPS_NO,
      fieldName: 'clientName',
      proposedValue: 'Ravi Kumar',
      description: 'The client name is spelled wrong on the policy.',
    });
    expect(targetFieldFor(parsed)).toBe('clientName');
  });

  it('rejects a blank description even though the client would have allowed it', () => {
    // The form marks the field required, but the action is an HTTP endpoint with
    // a stable id: it is reachable with no form in front of it at all. This is
    // the layer that actually enforces the rule, and the database CHECK is the
    // third. A client that "would have allowed it" is exactly the case here —
    // whitespace passes an HTML `required` attribute.
    for (const description of ['', '   ', '\n\t', undefined]) {
      const result = correctionSubmitSchema.safeParse({
        category: 'OTHERS',
        appsNo: VALID_APPS_NO,
        fieldName: 'clientName',
        proposedValue: 'Ravi Kumar',
        description,
      });
      expect(result.success).toBe(false);
      expect(errorFor(result, 'description')).toMatch(/description/i);
    }
  });

  it('rejects a field that is not on a sales record', () => {
    const result = correctionSubmitSchema.safeParse({
      category: 'OTHERS',
      appsNo: VALID_APPS_NO,
      fieldName: 'commissionRate',
      proposedValue: '12',
      description: 'Wrong commission.',
    });
    expect(result.success).toBe(false);
    expect(errorFor(result, 'fieldName')).toMatch(/not a field/i);
  });

  it('refuses to let a correction rewrite the record identity', () => {
    // apps_no is the key every version row, audit entry and correction points
    // at. A re-import fixes a wrong application number; a correction cannot.
    const result = correctionSubmitSchema.safeParse({
      category: 'OTHERS',
      appsNo: VALID_APPS_NO,
      fieldName: 'appsNo',
      proposedValue: '6167509576',
      description: 'Typo in the application number.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a value the importer would reject for the named field', () => {
    const result = correctionSubmitSchema.safeParse({
      category: 'OTHERS',
      appsNo: VALID_APPS_NO,
      fieldName: 'loginDate',
      proposedValue: 'sometime in June',
      description: 'The login date is wrong.',
    });
    expect(result.success).toBe(false);
    expect(errorFor(result, 'proposedValue')).toBeDefined();
  });

  it('requires a non-empty proposed value', () => {
    const result = correctionSubmitSchema.safeParse({
      category: 'OTHERS',
      appsNo: VALID_APPS_NO,
      fieldName: 'clientName',
      proposedValue: '   ',
      description: 'Name is blank.',
    });
    expect(result.success).toBe(false);
  });
});

describe('proposed-value normalization reuses the importer (spec 6.3)', () => {
  it('uppercases SM_ID, which the sales_record CHECK would otherwise refuse', () => {
    expect(normalizeProposedValue('smId', 'c2cm21350').value).toBe('C2CM21350');
  });

  it('keeps money as a string with two decimals', () => {
    expect(normalizeProposedValue('fp', '4195.42').value).toBe('4195.42');
  });

  it('maps the AutoPay vocabulary', () => {
    expect(normalizeProposedValue('autopay', 'Y').value).toBe('Yes');
  });

  it('uppercases a status', () => {
    expect(normalizeProposedValue('status', 'issued').value).toBe('ISSUED');
  });

  it('refuses an identifier that already lost precision', () => {
    const { value, issues } = normalizeProposedValue('policyNo', '5.92E+09');
    expect(value).toBeNull();
    expect(issues.some((i) => i.severity === 'ERROR')).toBe(true);
  });

  it('reports an unknown field rather than silently passing it through', () => {
    const { value, issues } = normalizeProposedValue('notAField', 'x');
    expect(value).toBeNull();
    expect(issues[0].code).toBe('FIELD_UNKNOWN');
  });
});
