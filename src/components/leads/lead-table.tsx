import { Badge, EmptyState, Table, Td, Th } from '@/components/ui';
import { formatDate, orDash } from '@/lib/format';
import type { LeadListRow } from '@/lib/leads/queries';

/**
 * The lead grid, shared by the rep's page and the admin's.
 *
 * There is no detail route behind a row and no action on one. Leads are read
 * only (spec 6.3) — not correctable, not part of the close — so a link here
 * would promise a screen that has nothing to say.
 */
export function LeadTable({
  rows,
  variant,
}: {
  rows: LeadListRow[];
  variant: 'admin' | 'sales';
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No leads match these filters"
        description="Clear a filter or widen the search term. An empty result here means no matching lead exists in your scope, not that one is hidden."
      />
    );
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Lead No</Th>
          <Th>Registered</Th>
          {variant === 'admin' ? <Th>SM</Th> : null}
          <Th>Location</Th>
          <Th>Source</Th>
          <Th>Product</Th>
          <Th>Team leader</Th>
          {variant === 'admin' ? <Th>CCM</Th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="hover:bg-slate-50">
            <Td className="font-mono text-xs font-medium text-slate-900">{row.leadNo}</Td>
            <Td className="whitespace-nowrap">{formatDate(row.registerDate)}</Td>
            {variant === 'admin' ? (
              <Td>
                {row.isUnassigned ? (
                  // The sentinel code itself is never shown: `111222-UN` is an
                  // artefact of the workbook, and printing it invites someone to
                  // paste it into the SM_CODE filter as though it were a rep.
                  <Badge tone="warning">Unassigned</Badge>
                ) : (
                  <>
                    <span className="font-mono text-xs">{orDash(row.smCode)}</span>
                    {row.smName ? (
                      <span className="block text-xs text-slate-500">{row.smName}</span>
                    ) : null}
                  </>
                )}
              </Td>
            ) : null}
            <Td>
              {orDash(row.location)}
              {/* The sheet carries Location twice and the two disagree often
                  enough to matter; showing only the first would quietly pick a
                  winner the data does not name. */}
              {row.locationAlt && row.locationAlt !== row.location ? (
                <span className="block text-xs text-slate-500">{row.locationAlt}</span>
              ) : null}
            </Td>
            <Td>{orDash(row.source)}</Td>
            <Td>
              {orDash(row.productType)}
              {row.productMix ? (
                <span className="block text-xs text-slate-500">{row.productMix}</span>
              ) : null}
            </Td>
            <Td>{orDash(row.tlName)}</Td>
            {variant === 'admin' ? <Td>{orDash(row.ccmName)}</Td> : null}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
