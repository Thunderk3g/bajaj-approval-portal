CREATE INDEX IF NOT EXISTS sales_record_apps_no_trgm
  ON sales_record USING gin (apps_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sales_record_policy_no_trgm
  ON sales_record USING gin (policy_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sales_record_client_name_trgm
  ON sales_record USING gin (client_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sales_record_sm_name_trgm
  ON sales_record USING gin (sm_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sales_record_extra_gin
  ON sales_record USING gin (extra);
