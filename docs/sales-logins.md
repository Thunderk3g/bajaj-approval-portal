# Sales logins

`npm run setup:sales` gives every rep who owns leads in the imported `Lead Dump`
a working account, so the correction flow can be walked as a rep rather than as
an admin pretending to be one.

```
npm run setup:sales -- --dry-run        # show the selection, write nothing
npm run setup:sales                     # provision everyone
npm run setup:sales -- --limit 20       # provision the 20 busiest, report the rest
```

Sign-in is at `${BETTER_AUTH_URL}/login`.

## The credentials are printed once and stored nowhere

Not in this file, not in the repository, not in the database. `account.password`
holds a Better Auth scrypt hash, which is not reversible; the plaintext exists
only on the screen of the run that produced it. **Copy the table before you close
the terminal.**

There is still no self-service reset and nothing on `/admin/users`, but a lost
password no longer means losing the account:

```bash
npx tsx scripts/create-sales-user.ts ICCS427343 --reset-password
```

That mints a new password for the existing account, in place. The flag is
required and deliberately verbose: a reset locks out whoever holds the old
password with no message anywhere explaining why, so it must be something asked
for in as many words rather than something a re-run does by accident. Running
the same script WITHOUT the flag refuses and says so.

Deleting and reprovisioning was the old answer and is now the wrong one. It also
does not work for the reps most likely to need it:

```sql
delete from "user" where sm_id = 'ICCS427343';   -- fails for an active rep
```

`audit_log.actor_id` is `on delete restrict`, deliberately, so the delete is
refused the moment a rep has done anything auditable. The reset path exists
precisely because the accounts worth recovering are the ones that cannot be
deleted.

## What the script guarantees

**It never touches an account that already exists.** Skipping is keyed on
`user.sm_id`, not on the derived email, because this deployment already has
`sm1@bajajlife.com` holding ICCSP90766 and `sm2@bajajlife.com` holding C2CM21350
— matching on the address alone would hand those two reps a second login onto the
same book. A rerun prints them under "Already provisioned" and leaves the stored
hash byte-identical.

**The address is derived from the SM code**, as `sm.<code>@bajajlife.com`
(`ICCS427343` → `sm.iccs427343@bajajlife.com`). Derivation is what makes the
rerun idempotent, and the code is the only stable identifier in the data —
`lead.sm_name` is free text off a spreadsheet. Nothing sends mail, so the address
is an identifier that happens to be shaped like one.

**`111222-UN` never becomes a login.** It is the Lead Dump's own marker for a
lead nobody has been given yet (`UNASSIGNED_SM_CODE` in `ingest/app/leads.py`),
carried by ~2.7% of rows. The unassigned pool is counted in the summary and left
alone. A row carrying the sentinel with `is_unassigned` left false — the flag and
the column it was denormalised from having drifted apart — is refused by name
rather than filtered away silently.

**Nothing is truncated in silence.** Every candidate ends up in exactly one line
of the summary: created, already provisioned, refused (with the reason), or
dropped by `--limit` (with the count).

## Reps with no Manpower roster row

Around a dozen per import — 23 of the 198 accounts on the first live run, against
a 187-row roster. They are provisioned anyway: the leads are real and the roster
sheet is the thing that is behind (spec 6.4, 13.2 note 7). The count is printed
at the end of the run, and the wording distinguishes the two cases, because they
need different actions — a roster with rows and gaps is a list of reps to chase,
an empty `manpower` is one sheet nobody has imported yet.

**The script does not write `manpower` rows for them**, even though `is_orphan`
exists for exactly this shape of gap. Three reasons, in order of weight:

1. `applyCorrection` resolves a mapping claim's `sm_name` from the roster and
   warns when the code has no row at all. A row with a null name is still a row:
   it makes that check pass, so the approval would blank the record's rep name
   with no warning attached. Leaving the roster empty keeps the warning firing.
2. Every existing write to `manpower` happens inside the import commit
   transaction and carries a `source_batch_id`. A row from this script would
   assert a roster entry that no upload produced.
3. It would zero `leadSummary.orphanCodes` and empty `listOrphanCodes`, which is
   the admin's only signal that the roster has fallen behind the lead data.
   Writing the rows would answer that question with rows this script invented.

Provisioning does not need the row: `createUserAccount` never reads `manpower`,
and the account is fully visible and editable on `/admin/users`. Committing a
workbook whose `Manpower` sheet covers those codes is what closes the gap.

## Scope

Selection reads `lead` only. A rep who owns `sales_record` rows but no leads is
not provisioned here — `/admin/users` already lists those from `listRoster`,
which folds in SM_IDs found in `sales_record` and absent from the roster.
