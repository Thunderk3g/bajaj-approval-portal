/**
 * The canonical field registry.
 *
 * One list, three consumers: the import mapper scores source headers against
 * `aliases` to suggest a mapping, the correction forms render `label` and
 * validate against `kind`, and the Excel export emits columns in this order.
 * Keeping them in one place is what stops the export drifting from the import.
 *
 * `key` is the Drizzle property name on `salesRecord` — not the SQL column and
 * not the source header. The source header is deliberately NOT hardcoded
 * anywhere: spec section 6.2 records four fields whose real names differ from the
 * original requirement (APE is `ANP`, FRP is `FP`, Issuance_Date is
 * `Issued_Date`), and next month's workbook may rename more. Aliases absorb
 * that; the admin's confirmed mapping is the authority.
 */

export type FieldKind = 'identifier' | 'text' | 'date' | 'money' | 'autopay' | 'status';

export type CanonicalField = {
  key: string;
  label: string;
  kind: FieldKind;
  /** Blocks commit when absent. Only Apps_No and SM_ID qualify — spec section 6.3. */
  required: boolean;
  /** Lowercased, alphanumeric-only spellings this field answers to. */
  aliases: string[];
};

/**
 * Reduces a header to its comparison form: lowercase, alphanumerics only.
 *
 * `SM_ID`, `sm id`, `SM-Id` and `Sm.Id` all collapse to `smid`, so the mapper
 * matches on meaning rather than punctuation. This is the same normalization
 * applied to both sides of every alias comparison.
 */
export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export const CANONICAL_FIELDS: readonly CanonicalField[] = [
  {
    key: 'appsNo',
    label: 'Application number',
    kind: 'identifier',
    required: true,
    aliases: ['appsno', 'appno', 'applicationno', 'applicationnumber', 'appnumber', 'appsnumber'],
  },
  {
    key: 'policyNo',
    label: 'Policy number',
    kind: 'identifier',
    required: false,
    aliases: ['policyno', 'policynumber', 'polno'],
  },
  {
    key: 'clientName',
    label: 'Client name',
    kind: 'text',
    required: false,
    aliases: ['clientname', 'customername', 'client', 'customer', 'laname', 'proposername'],
  },
  {
    key: 'leadId',
    label: 'Lead ID',
    kind: 'text',
    required: false,
    aliases: ['leadid', 'lead', 'leadno'],
  },
  {
    // The new business-dashboard column. The June workbook spells it `agent
    // code` — lowercase, a space, and the last of the 37 columns on `Login
    // Data` — which is the fourth name in this registry that differs from the
    // one the requirement uses, after ANP/APE, FP/FRP and Issued_Date. The key
    // and label follow the requirement; `agentcode` in the aliases is what
    // actually matches the file, exactly as `ape` and `frp` do above.
    //
    // Placed at the head of the attribution block — agent, then SM, then TL,
    // then CCM — so the export reads outwards from the person who made the sale.
    //
    // NO BARE `agent` ALIAS, deliberately. It is five characters, so it clears
    // the four-character noise floor in `scoreColumn` and would PREFIX-match any
    // `Agent_Name` column — a header the `SM Summary` sheet already carries. It
    // would win that column for `agentId` in any file that ships a name but no
    // code, which is the silent mis-mapping that guard exists to prevent. Every
    // real spelling is covered by a specific alias below.
    //
    // `required: false` even though the dashboard now always sends it: the
    // column arrived after go-live, so every workbook already imported lacks it,
    // and a required field blocks the commit of any file that predates it.
    // `identifier`, NOT `text`, and the June file is what decides it.
    //
    // All 1171 rows carry a value, there are three distinct codes, and they come
    // back from the `.xlsb` as BOTH `number` and `string` in the same column:
    // `3000000007` and `2000003060` are numeric, `59L0000000` is not. That is
    // the Apps_No shape exactly, and `identifier` is the kind that handles it —
    // a raw number goes through BigInt rather than JS display text, incoming
    // scientific notation is refused instead of being expanded into invented
    // digits, and the export writes the column with a text number format so
    // Excel cannot re-render a ten-digit code as 3.0E+09 on the way out.
    //
    // `text` would have worked for these three values today and failed quietly
    // on the first code long enough for Excel to reformat.
    key: 'agentId',
    label: 'Agent ID',
    kind: 'identifier',
    required: false,
    aliases: ['agentcode', 'agentid', 'agentno', 'agentnumber', 'agtid', 'advisorid', 'advisorcode'],
  },
  {
    key: 'smId',
    label: 'SM ID',
    kind: 'text',
    required: true,
    aliases: ['smid', 'salesmanagerid', 'smcode', 'smempid'],
  },
  {
    key: 'smName',
    label: 'SM name',
    kind: 'text',
    required: false,
    aliases: ['smname', 'salesmanagername', 'sm'],
  },
  { key: 'tlId', label: 'TL ID', kind: 'text', required: false, aliases: ['tlid', 'teamleaderid', 'tlcode'] },
  {
    key: 'tlName',
    label: 'TL name',
    kind: 'text',
    required: false,
    aliases: ['tlname', 'teamleadername', 'tl'],
  },
  { key: 'ccmId', label: 'CCM ID', kind: 'text', required: false, aliases: ['ccmid', 'ccmcode'] },
  { key: 'ccmName', label: 'CCM name', kind: 'text', required: false, aliases: ['ccmname', 'ccm'] },
  {
    key: 'location',
    label: 'Location',
    kind: 'text',
    required: false,
    aliases: ['location', 'branch', 'city', 'region'],
  },
  {
    key: 'loginDate',
    label: 'Login date',
    kind: 'date',
    required: false,
    aliases: ['logindate', 'loginon', 'applicationdate', 'appdate'],
  },
  {
    // "Issuance_Date" in the original requirement; the workbook calls it
    // Issued_Date. Both spellings resolve here so the admin never has to know.
    key: 'issuedDate',
    label: 'Issued date',
    kind: 'date',
    required: false,
    aliases: ['issueddate', 'issuancedate', 'issuedon', 'dateofissuance', 'policyissuedate'],
  },
  {
    // FRP in the requirement, FP in the file. First Premium.
    key: 'fp',
    label: 'FP (first premium)',
    kind: 'money',
    required: false,
    aliases: ['fp', 'frp', 'firstpremium', 'firstyearpremium'],
  },
  {
    // APE in the requirement, ANP in the file. Annualised New Premium.
    key: 'anp',
    label: 'ANP (annualised new premium)',
    kind: 'money',
    required: false,
    aliases: ['anp', 'ape', 'annualisedpremium', 'annualizedpremium', 'annualnewpremium'],
  },
  {
    key: 'productName',
    label: 'Product name',
    kind: 'text',
    required: false,
    aliases: ['productname', 'product', 'plainname', 'planname'],
  },
  {
    key: 'productType',
    label: 'Product type',
    kind: 'text',
    required: false,
    aliases: ['producttype', 'plantype', 'category'],
  },
  {
    key: 'productVariant',
    label: 'Product variant',
    kind: 'text',
    required: false,
    aliases: ['productvariant', 'variant', 'planvariant'],
  },
  {
    key: 'bookingFrequency',
    label: 'Booking frequency',
    kind: 'text',
    required: false,
    aliases: ['bookingfrequency', 'frequency', 'premiumfrequency', 'mode', 'payfrequency'],
  },
  {
    key: 'payMode',
    label: 'Pay mode',
    kind: 'text',
    required: false,
    aliases: ['paymode', 'paymentmode', 'modeofpayment'],
  },
  {
    key: 'status',
    label: 'Status',
    kind: 'status',
    required: false,
    aliases: ['status', 'applicationstatus', 'currentstatus'],
  },
  {
    key: 'status2',
    label: 'Status 2',
    kind: 'status',
    required: false,
    aliases: ['status2', 'substatus', 'statustwo', 'disposition'],
  },
  {
    key: 'autopay',
    label: 'AutoPay',
    kind: 'autopay',
    required: false,
    aliases: ['autopay', 'auto', 'autodebit', 'standinginstruction', 'si', 'nach'],
  },
  {
    // The channel a policy was booked under — BAU or BFL — and the field a
    // BAU_TO_BFL correction targets (2026-08-06 spec section 3).
    //
    // `required: false` for the same reason `agentId` is: the column arrives with
    // this release, so every workbook already committed lacks it, and a required
    // field would block the commit of any file that predates it.
    //
    // NO BARE `source` ALIAS. Six characters clears the noise floor in
    // `scoreColumn`, and `Lead Dump` already ships a `Source` column with an
    // entirely different meaning (lead origin, not booking channel) — a bare
    // alias would win that header on any workbook whose sheets get mapped
    // together, which is the silent mis-mapping the guard on `agentId` exists to
    // prevent. `sourcechannel` and the explicit BAU/BFL spellings are the ones
    // that actually appear.
    key: 'sourceChannel',
    label: 'Source channel',
    kind: 'text',
    required: false,
    aliases: [
      'sourcechannel',
      'channel',
      'businesschannel',
      'businesstype',
      'baubfl',
      'bflbau',
      'bookingchannel',
    ],
  },
] as const;

export const FIELD_BY_KEY: ReadonlyMap<string, CanonicalField> = new Map(
  CANONICAL_FIELDS.map((f) => [f.key, f]),
);

export function fieldLabel(key: string): string {
  return FIELD_BY_KEY.get(key)?.label ?? key;
}

export const REQUIRED_FIELD_KEYS: readonly string[] = CANONICAL_FIELDS.filter((f) => f.required).map(
  (f) => f.key,
);

/**
 * The record fields a correction category may target — spec section 7.1.
 *
 * MAPPING lists only `smId`: `smName` moves with it, but it is resolved from the
 * Manpower roster at approval time rather than proposed as free text, so it is
 * never a target the submitter picks. Both directions of MAPPING — claiming a
 * sale in and transferring one out, 2026-07-29 spec section 2 — target that same
 * one field, which is what lets `correction_one_open_per_field` make the two
 * mutually exclusive on a given record without knowing either exists.
 *
 * OTHERS is open — the submitter names the field — and is validated separately
 * against this same registry. It stays the full list here rather than excluding
 * `smId`: `resolveTargetField` reads this table when APPLYING an already-approved
 * request, and narrowing it would strand the historical rows described in
 * 2026-07-29 spec section 9. New submissions are refused at
 * `OTHERS_FORBIDDEN_FIELDS` instead, which is the submission-time gate.
 */
export const CATEGORY_FIELDS: Record<string, readonly string[]> = {
  AUTOPAY: ['autopay'],
  MAPPING: ['smId'],
  ISSUANCE_DATE: ['issuedDate'],
  AGENT_ID: ['agentId'],
  BAU_TO_BFL: ['sourceChannel'],
  OTHERS: CANONICAL_FIELDS.map((f) => f.key),
};
