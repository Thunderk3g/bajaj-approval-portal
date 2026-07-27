import { Alert, Card, DetailRow, StatusBadge } from '@/components/ui';
import { FIELD_BY_KEY, fieldLabel } from '@/lib/fields';
import { formatDate, formatDateTime, formatMoney, orDash } from '@/lib/format';
import { detectGaps, GAP_LABELS } from '@/lib/records/gaps';
import type { RecordDetailRow } from '@/lib/records/query';
import { GapBadges } from './gap-badges';

/**
 * The field groups of spec section 5.4, in that order.
 *
 * Grouped rather than listed alphabetically because the questions people bring
 * to this page are grouped that way too — "who is this credited to" is one
 * question spanning seven columns, not seven questions.
 */
const GROUPS: Array<{ title: string; keys: Array<keyof RecordDetailRow> }> = [
  { title: 'Identity', keys: ['appsNo', 'policyNo', 'clientName', 'leadId'] },
  { title: 'Attribution', keys: ['smId', 'smName', 'tlId', 'tlName', 'ccmId', 'ccmName', 'location'] },
  { title: 'Dates', keys: ['loginDate', 'issuedDate'] },
  { title: 'Money', keys: ['fp', 'anp'] },
  {
    title: 'Product',
    keys: ['productName', 'productType', 'productVariant', 'bookingFrequency', 'payMode'],
  },
  { title: 'Status', keys: ['status', 'status2', 'autopay'] },
];

function renderValue(key: string, value: unknown) {
  const kind = FIELD_BY_KEY.get(key)?.kind;

  // Money is a numeric(18,2) string from the driver and is formatted, never
  // parsed — the whole reason the column is not a float.
  if (kind === 'money') return <span className="tabular-nums">{formatMoney(value as string | null)}</span>;
  if (kind === 'date') return formatDate(value as string | null);
  if (kind === 'status') return <StatusBadge status={value as string | null} />;
  if (kind === 'identifier' || key === 'smId') {
    return <span className="font-mono text-sm">{orDash(value)}</span>;
  }
  return orDash(value);
}

export function RecordDetail({ record }: { record: RecordDetailRow }) {
  const gaps = detectGaps(record);
  const extraEntries = Object.entries(record.extra ?? {}).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-4">
      {gaps.length > 0 ? (
        <Alert tone={gaps.includes('MISSING_POLICY_NO') ? 'danger' : 'warning'} title="Reconciliation gaps">
          <ul className="mt-1 list-inside list-disc">
            {gaps.map((gap) => (
              <li key={gap}>{GAP_LABELS[gap]}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs">
            Flagged because this application is ISSUED. The same blank on a PENDING or REJECTED row
            is not a defect — spec section 6.4.
          </p>
        </Alert>
      ) : (
        <Alert tone="success" title="No reconciliation gaps">
          <GapBadges record={record} emptyLabel="Nothing missing on this record." />
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {GROUPS.map((group) => (
          <Card key={group.title} title={group.title}>
            <dl>
              {group.keys.map((key) => (
                <DetailRow key={String(key)} label={fieldLabel(String(key))}>
                  {renderValue(String(key), record[key])}
                </DetailRow>
              ))}
            </dl>
          </Card>
        ))}
      </div>

      <Card
        title="Preserved columns"
        description="Source columns with no first-class field. Kept verbatim so no import loses data, and searchable — spec section 5.4."
      >
        {extraEntries.length === 0 ? (
          <p className="text-sm text-slate-500">No additional columns were carried on this row.</p>
        ) : (
          <dl>
            {extraEntries.map(([key, value]) => (
              <DetailRow key={key} label={key}>
                {typeof value === 'object' && value !== null ? (
                  <code className="text-xs">{JSON.stringify(value)}</code>
                ) : (
                  orDash(value)
                )}
              </DetailRow>
            ))}
          </dl>
        )}
      </Card>

      <Card title="Provenance">
        <dl>
          <DetailRow label="Current version">{record.currentVersion}</DetailRow>
          <DetailRow label="Has corrections">{record.hasCorrections ? 'Yes' : 'No'}</DetailRow>
          <DetailRow label="Source row">{orDash(record.sourceRowNumber)}</DetailRow>
          <DetailRow label="Imported">{formatDateTime(record.createdAt)}</DetailRow>
          <DetailRow label="Last updated">{formatDateTime(record.updatedAt)}</DetailRow>
        </dl>
      </Card>
    </div>
  );
}
