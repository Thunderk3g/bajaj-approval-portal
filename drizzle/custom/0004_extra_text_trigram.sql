-- Substring search over the preserved `extra` columns — spec section 9.1.
--
-- `sales_record_extra_gin` (0000) indexes the jsonb itself, which serves
-- containment and key-existence but cannot serve a substring match. Search has
-- to reach `extra` because that is where every unmapped source column lands
-- (FY, Login_Month, Source, RECEIPT_NO, Product_Code, PPT, BT, WROP, BASBA,
-- LA Occupation, IP_GENDER — section 5.4), and section 9.1 requires those values
-- stay searchable.
--
-- Without this index the `extra::text ILIKE '%term%'` arm of the search OR is
-- unindexed, and one unindexed arm degrades the entire OR to a sequential scan
-- however well the other four columns are indexed. That is survivable at the
-- current few thousand rows and stops being survivable as the master table
-- accumulates monthly uploads (section 6.7) — which it is designed to do.
CREATE INDEX IF NOT EXISTS sales_record_extra_trgm
  ON sales_record USING gin ((extra::text) gin_trgm_ops);
