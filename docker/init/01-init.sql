CREATE DATABASE sdrp_test OWNER sdrp;

\connect sdrp
CREATE EXTENSION IF NOT EXISTS pg_trgm;

\connect sdrp_test
CREATE EXTENSION IF NOT EXISTS pg_trgm;
