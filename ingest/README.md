# reconciliation-ingest

The parsing and staging service. Called only by the Next.js app, over the
internal network, with a shared secret — see `app/main.py` for the routes and
`Dockerfile` for how it is built and why it listens on 8006.

```
python -m pytest -q          # from this directory
```

The tests run against the real workbook when it is present, and skip when it is
not. Point them elsewhere with `TEST_WORKBOOK=<path>`.

## Splitting the collective workbook

The admin's monthly file is one 9.14 MB `.xlsb` carrying ten sheets, and the
portal takes one workbook per batch. `app/split.py` writes each sheet out as a
file of its own, so a month in which only `Manpower` changed no longer costs a
full re-upload and a full re-parse of `Lead Dump`.

```
python -m app.split "Businesses Dashboard Jun'26.xlsb" ./split
python -m app.split "Businesses Dashboard Jun'26.xlsb" ./split "Login Data"   # one sheet
```

Output is `.xlsx`, because that is what `ALLOWED_EXTENSIONS` in
`src/lib/import/actions.ts` accepts and the upload action checks the first four
bytes against the ZIP signature. Filenames carry the sheet's position in the
workbook — `06-login-data.xlsx` — which makes them unique without consulting the
other sheets and keeps a sheet called `CON` or `NUL` from becoming a reserved
device name. Running it twice produces the same names and overwrites.

Every sheet is reported, written or not. On the June file, eight of ten are
written in about 35 s; `Lead Dump` accounts for 34 s of that and is streamed one
row at a time, because its declared range is 54,508 x 16,383 and materialising it
asks for roughly 28 GB.

`BFL & BAU` and `Overall Dashboard` are refused, with their row counts in the
reason. Their first row names 1 column of 16,208 and 3 of 16,380 — a stray label
pasted some 16,000 columns right of a block that is really 20 and 34 wide — so
there is no header row to write under, and the file would be 16,000 columns of
`(column N)`. They are dashboards; nothing else reads them.

### Known limits, in code this module does not own

- The `Lead Dump` output cannot be imported by the leads path. `stream_leads`
  opens with pyxlsb, which reads `.xlsb` only, and `read_sheet` refuses any sheet
  named `Lead Dump` by NAME rather than by size — so the split file, a harmless
  15-column table, is refused by one reader and unopenable by the other. Making
  it importable means teaching the leads path to read `.xlsx`; the sheet keeps
  its real name here regardless, because renaming it would be a lie about what
  the file holds.
- `read_sheet` does not narrow a header to its contiguous width the way
  `stream_leads` does, so `BFL & BAU` and `Overall Dashboard` come back 16,208
  and 16,380 columns wide. That is what the splitter has to detect and refuse.
  The same widths reach the review page today.
