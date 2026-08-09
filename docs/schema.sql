-- =====================================================================
-- ITC Guard — PostgreSQL schema
--
-- Not yet in use. The application stores everything in browser
-- localStorage today, and "your ledger never leaves your machine" is a
-- real selling point that a database quietly deletes. Adopt this only
-- when multi-user access or cross-device history genuinely requires it,
-- and make the upload explicit and opt-in when you do.
--
-- Targets PostgreSQL 14+. Written for Postgres specifically rather than
-- portable SQL, because the two features that matter most here —
-- row-level security for tenant isolation, and CHECK constraints that
-- refuse to store impossible money — are worth more than portability.
--
-- THE MONEY RULE, which this schema enforces at the storage layer:
-- every monetary column is BIGINT paise. Never NUMERIC, never FLOAT.
-- A float rupee value silently loses money at scale, and the whole
-- product is a claim about rupees being exactly right.
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";     -- case-insensitive email

-- ---------------------------------------------------------------------
-- Enumerated domains
--
-- Enums rather than free-text CHECKs so an invalid tier or verdict is
-- rejected by the database, not merely discouraged by the application.
-- ---------------------------------------------------------------------

CREATE TYPE document_type   AS ENUM ('INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE');
CREATE TYPE supply_type     AS ENUM ('B2B', 'B2BA', 'CDNR', 'CDNRA', 'ISD', 'IMPG', 'IMPS');
CREATE TYPE msme_status     AS ENUM ('MICRO', 'SMALL', 'MEDIUM', 'NOT_MSME', 'UNKNOWN');
CREATE TYPE match_tier      AS ENUM ('EXACT', 'TOLERANT', 'MISMATCH', 'FUZZY', 'BOOKS_ONLY', 'GSTR2B_ONLY');
CREATE TYPE severity        AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');
CREATE TYPE risk_band       AS ENUM ('SAFE', 'WATCH', 'HIGH', 'SEVERE');
CREATE TYPE vendor_trend    AS ENUM ('NEW', 'IMPROVING', 'STABLE', 'WORSENING');
CREATE TYPE payhold_verdict AS ENUM ('PAY', 'HOLD', 'PAY_NET_OF_GST', 'ESCALATE');

CREATE TYPE risk_rule AS ENUM (
  'SEC_16_2_AA_NOT_IN_2B',
  'ITC_MARKED_INELIGIBLE',
  'RULE_37_180_DAY',
  'RULE_37A_SUPPLIER_3B_UNFILED',
  'SEC_16_4_TIME_BARRED',
  'VALUE_MISMATCH',
  'IN_2B_NOT_IN_BOOKS',
  'SEC_43B_H_MSME_OVERDUE',
  'INVALID_OR_CANCELLED_GSTIN'
);

CREATE TYPE recommended_action AS ENUM (
  'CHASE_VENDOR', 'HOLD_PAYMENT', 'RELEASE_PAYMENT', 'REVERSE_CREDIT',
  'CLAIM_NOW', 'CORRECT_BOOKS', 'VERIFY_VENDOR'
);

-- A GST return period as the portal emits it: MMYYYY.
CREATE DOMAIN gst_period AS TEXT
  CHECK (VALUE ~ '^(0[1-9]|1[0-2])[0-9]{4}$');

-- 15 characters: 2 state + 10 PAN + 1 entity + 1 'Z' + 1 checksum.
-- Deliberately NOT applied to supplier columns — a foreign vendor
-- legitimately has none, and an import must still be storable.
CREATE DOMAIN gstin AS TEXT
  CHECK (VALUE ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$');

-- ---------------------------------------------------------------------
-- Tenancy and users
-- ---------------------------------------------------------------------

CREATE TABLE tenant (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL CHECK (length(trim(name)) > 0),
  gstin           gstin NOT NULL,

  -- Assumptions that change what the engine computes, so they belong
  -- with the tenant and not in a config file.
  effective_tax_rate      NUMERIC(5,4) NOT NULL DEFAULT 0.2600
    CHECK (effective_tax_rate >= 0 AND effective_tax_rate <= 1),
  msme_written_agreement  BOOLEAN NOT NULL DEFAULT TRUE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (gstin)
);

CREATE TABLE app_user (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  email          CITEXT NOT NULL,
  display_name   TEXT NOT NULL,

  -- scrypt/argon2 output only. A plaintext or reversibly-encrypted
  -- password in this column is a breach waiting to be published.
  password_hash  TEXT NOT NULL,

  -- Maps to the roles the product actually has: an executive who reads,
  -- an AP operator who acts, a CA who audits, an admin who configures.
  role           TEXT NOT NULL DEFAULT 'operator'
                 CHECK (role IN ('admin', 'operator', 'auditor', 'viewer')),

  -- Brute-force state, so a lockout survives a server restart. The
  -- in-memory limiter in the app is per-process and does not.
  failed_logins    INTEGER NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until     TIMESTAMPTZ,
  last_login_at    TIMESTAMPTZ,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at    TIMESTAMPTZ,

  UNIQUE (tenant_id, email)
);

CREATE INDEX ON app_user (tenant_id) WHERE disabled_at IS NULL;

-- Server-side sessions, for when statelessness stops being enough.
-- Storing only a HASH of the token means a leaked database backup does
-- not hand over live sessions.
CREATE TABLE user_session (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  ip_address     INET,
  user_agent     TEXT,

  CHECK (expires_at > issued_at)
);

CREATE INDEX ON user_session (user_id) WHERE revoked_at IS NULL;
CREATE INDEX ON user_session (expires_at);

-- ---------------------------------------------------------------------
-- Vendors
-- ---------------------------------------------------------------------

CREATE TABLE vendor (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,

  -- Nullable on purpose: foreign suppliers have no GSTIN. Validity is
  -- recorded as a separate flag so an invalid one can be stored,
  -- reported, and corrected rather than rejected at the door.
  gstin             TEXT,
  gstin_valid       BOOLEAN NOT NULL DEFAULT FALSE,
  is_foreign        BOOLEAN NOT NULL DEFAULT FALSE,

  name              TEXT NOT NULL,
  -- Normalised name (legal suffixes stripped) for grouping and fallback
  -- matching when there is no GSTIN to anchor on.
  name_key          TEXT NOT NULL,
  pan               TEXT,
  msme_status       msme_status NOT NULL DEFAULT 'UNKNOWN',

  -- Beneficiary details for the payment file. Bank account numbers are
  -- sensitive; see the RLS section and encrypt at rest at the volume
  -- level, or use pgcrypto here if the threat model requires it.
  bank_account_number  TEXT,
  bank_ifsc            TEXT CHECK (bank_ifsc IS NULL OR bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_account_holder  TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One row per GSTIN per tenant. Foreign vendors (NULL gstin) are
  -- exempt from this and deduplicated by name_key instead.
  UNIQUE (tenant_id, gstin)
);

CREATE INDEX ON vendor (tenant_id, name_key);
CREATE UNIQUE INDEX vendor_foreign_unique
  ON vendor (tenant_id, name_key) WHERE gstin IS NULL;

-- ---------------------------------------------------------------------
-- Reconciliation runs
-- ---------------------------------------------------------------------

CREATE TABLE reconciliation_run (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  period             gst_period NOT NULL,

  -- The reference date every statutory clock was measured from. Stored
  -- because re-running with a different as-of date legitimately gives a
  -- different answer, and a working paper must say which one it used.
  as_of              DATE NOT NULL,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         UUID REFERENCES app_user(id) ON DELETE SET NULL,

  source_register    TEXT,
  source_portal      TEXT,
  is_sample          BOOLEAN NOT NULL DEFAULT FALSE,

  -- Control totals. The tie-out a CA checks before reading anything
  -- else, persisted so a stored run can be audited without recomputing.
  books_line_count   INTEGER NOT NULL DEFAULT 0,
  gstr2b_line_count  INTEGER NOT NULL DEFAULT 0,
  books_itc_paise        BIGINT NOT NULL DEFAULT 0,
  gstr2b_itc_paise       BIGINT NOT NULL DEFAULT 0,
  matched_itc_paise      BIGINT NOT NULL DEFAULT 0,
  books_only_itc_paise   BIGINT NOT NULL DEFAULT 0,
  gstr2b_only_itc_paise  BIGINT NOT NULL DEFAULT 0,
  balanced           BOOLEAN NOT NULL,
  imbalance_note     TEXT,
  total_at_risk_paise    BIGINT NOT NULL DEFAULT 0,
  auto_resolved_ratio    NUMERIC(5,4) CHECK (auto_resolved_ratio BETWEEN 0 AND 1),

  -- The money-conservation invariant, enforced by the database. If the
  -- application ever tries to persist a run whose parts do not sum to
  -- the whole, the write fails rather than producing a stored report
  -- that quietly does not add up.
  CONSTRAINT run_ties_out CHECK (
    balanced = FALSE OR books_itc_paise = matched_itc_paise + books_only_itc_paise
  ),
  CONSTRAINT run_note_when_unbalanced CHECK (
    balanced = TRUE OR imbalance_note IS NOT NULL
  )
);

CREATE INDEX ON reconciliation_run (tenant_id, period, created_at DESC);

-- ---------------------------------------------------------------------
-- Source documents
-- ---------------------------------------------------------------------

CREATE TABLE purchase_record (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           UUID NOT NULL REFERENCES reconciliation_run(id) ON DELETE CASCADE,
  tenant_id        UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  vendor_id        UUID REFERENCES vendor(id) ON DELETE SET NULL,

  supplier_gstin   TEXT,
  supplier_name    TEXT NOT NULL,
  invoice_number   TEXT NOT NULL,
  invoice_date     DATE NOT NULL,
  document_type    document_type NOT NULL DEFAULT 'INVOICE',

  taxable_value_paise BIGINT NOT NULL,
  igst_paise          BIGINT NOT NULL DEFAULT 0,
  cgst_paise          BIGINT NOT NULL DEFAULT 0,
  sgst_paise          BIGINT NOT NULL DEFAULT 0,
  cess_paise          BIGINT NOT NULL DEFAULT 0,
  invoice_value_paise BIGINT NOT NULL,

  place_of_supply  TEXT,
  reverse_charge   BOOLEAN NOT NULL DEFAULT FALSE,
  payment_date     DATE,
  msme_status      msme_status,
  source_row       INTEGER,

  -- A credit note must be negative and an invoice positive. Sign
  -- confusion here inverts a credit, which is exactly the class of
  -- silent error this product exists to catch.
  CONSTRAINT purchase_sign CHECK (
    (document_type = 'CREDIT_NOTE' AND taxable_value_paise <= 0)
    OR (document_type <> 'CREDIT_NOTE' AND taxable_value_paise >= 0)
  ),
  CONSTRAINT purchase_paid_after_invoiced CHECK (
    payment_date IS NULL OR payment_date >= invoice_date
  )
);

CREATE INDEX ON purchase_record (run_id);
CREATE INDEX ON purchase_record (tenant_id, supplier_gstin, invoice_date);

CREATE TABLE gstr2b_record (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           UUID NOT NULL REFERENCES reconciliation_run(id) ON DELETE CASCADE,
  tenant_id        UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  vendor_id        UUID REFERENCES vendor(id) ON DELETE SET NULL,

  supplier_gstin   TEXT,
  supplier_name    TEXT NOT NULL,
  invoice_number   TEXT NOT NULL,
  invoice_date     DATE NOT NULL,
  document_type    document_type NOT NULL DEFAULT 'INVOICE',
  supply_type      supply_type NOT NULL DEFAULT 'B2B',

  taxable_value_paise BIGINT NOT NULL,
  igst_paise          BIGINT NOT NULL DEFAULT 0,
  cgst_paise          BIGINT NOT NULL DEFAULT 0,
  sgst_paise          BIGINT NOT NULL DEFAULT 0,
  cess_paise          BIGINT NOT NULL DEFAULT 0,
  invoice_value_paise BIGINT NOT NULL,

  place_of_supply  TEXT,
  reverse_charge   BOOLEAN NOT NULL DEFAULT FALSE,
  period           gst_period NOT NULL,
  itc_available    BOOLEAN NOT NULL DEFAULT TRUE,
  itc_unavailable_reason TEXT,

  supplier_filing_period   gst_period,
  -- Tri-state on purpose: TRUE filed, FALSE confirmed unfiled (the
  -- Rule 37A trigger), NULL genuinely unknown. Collapsing NULL into
  -- FALSE would invent a reversal obligation out of missing data.
  supplier_gstr3b_filed    BOOLEAN,

  source_row       INTEGER
);

CREATE INDEX ON gstr2b_record (run_id);
CREATE INDEX ON gstr2b_record (tenant_id, supplier_gstin, invoice_date);
CREATE INDEX ON gstr2b_record (run_id) WHERE supplier_gstr3b_filed IS FALSE;

-- ---------------------------------------------------------------------
-- Engine output
-- ---------------------------------------------------------------------

CREATE TABLE match_result (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             UUID NOT NULL REFERENCES reconciliation_run(id) ON DELETE CASCADE,
  tenant_id          UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,

  tier               match_tier NOT NULL,
  confidence         NUMERIC(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),

  purchase_record_id UUID REFERENCES purchase_record(id) ON DELETE CASCADE,
  gstr2b_record_id   UUID REFERENCES gstr2b_record(id)  ON DELETE CASCADE,

  reasons            TEXT[] NOT NULL DEFAULT '{}',
  deltas             JSONB  NOT NULL DEFAULT '[]',
  itc_delta_paise    BIGINT NOT NULL DEFAULT 0,

  -- Every row must describe something real: a pair, or exactly one
  -- orphan. A match referencing neither side is a bug, and the
  -- database should not hold it.
  CONSTRAINT match_has_a_side CHECK (
    purchase_record_id IS NOT NULL OR gstr2b_record_id IS NOT NULL
  ),
  CONSTRAINT match_tier_agrees_with_sides CHECK (
    (tier = 'BOOKS_ONLY'  AND gstr2b_record_id   IS NULL AND purchase_record_id IS NOT NULL) OR
    (tier = 'GSTR2B_ONLY' AND purchase_record_id IS NULL AND gstr2b_record_id   IS NOT NULL) OR
    (tier NOT IN ('BOOKS_ONLY','GSTR2B_ONLY')
       AND purchase_record_id IS NOT NULL AND gstr2b_record_id IS NOT NULL)
  )
);

CREATE INDEX ON match_result (run_id, tier);
-- A 2B document may be claimed by at most one purchase line, and vice
-- versa. This is the one-to-one guarantee the matcher promises, made
-- structural rather than merely intended.
CREATE UNIQUE INDEX ON match_result (purchase_record_id) WHERE purchase_record_id IS NOT NULL;
CREATE UNIQUE INDEX ON match_result (gstr2b_record_id)   WHERE gstr2b_record_id   IS NOT NULL;

CREATE TABLE risk_finding (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             UUID NOT NULL REFERENCES reconciliation_run(id) ON DELETE CASCADE,
  tenant_id          UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  vendor_id          UUID REFERENCES vendor(id) ON DELETE SET NULL,

  rule               risk_rule NOT NULL,
  severity           severity  NOT NULL,
  citation           TEXT NOT NULL CHECK (length(trim(citation)) > 0),
  headline           TEXT NOT NULL,
  explanation        TEXT NOT NULL,

  -- Never negative. A negative "amount at risk" is the credit-note bug
  -- this product already fixed once; the constraint stops it returning.
  amount_at_risk_paise BIGINT NOT NULL CHECK (amount_at_risk_paise >= 0),

  deadline           DATE,
  recommended_action recommended_action NOT NULL,
  match_ids          UUID[] NOT NULL DEFAULT '{}'
);

CREATE INDEX ON risk_finding (run_id, severity, amount_at_risk_paise DESC);
CREATE INDEX ON risk_finding (tenant_id, vendor_id, rule);
CREATE INDEX ON risk_finding (run_id, deadline) WHERE deadline IS NOT NULL;

CREATE TABLE payhold_decision (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              UUID NOT NULL REFERENCES reconciliation_run(id) ON DELETE CASCADE,
  tenant_id           UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  vendor_id           UUID REFERENCES vendor(id) ON DELETE SET NULL,

  supplier_gstin      TEXT,
  supplier_name       TEXT NOT NULL,
  verdict             payhold_verdict NOT NULL,

  exposure_paise         BIGINT NOT NULL CHECK (exposure_paise >= 0),
  cost_of_paying_paise   BIGINT NOT NULL CHECK (cost_of_paying_paise  >= 0),
  cost_of_holding_paise  BIGINT NOT NULL CHECK (cost_of_holding_paise >= 0),

  binding_constraint  TEXT NOT NULL DEFAULT 'NONE',
  rationale           TEXT[] NOT NULL DEFAULT '{}',
  decide_by           DATE,
  match_ids           UUID[] NOT NULL DEFAULT '{}',

  -- A recommendation with no stated reasoning is not auditable, and an
  -- unauditable recommendation about money is worthless.
  CONSTRAINT decision_shows_working CHECK (cardinality(rationale) > 0)
);

CREATE INDEX ON payhold_decision (run_id, exposure_paise DESC);
CREATE UNIQUE INDEX ON payhold_decision (run_id, supplier_gstin)
  WHERE supplier_gstin IS NOT NULL;

-- ---------------------------------------------------------------------
-- Vendor history — the compounding asset
--
-- The one table that gets more valuable every month it is written to,
-- and the reason a customer's switching cost rises over time.
-- ---------------------------------------------------------------------

CREATE TABLE vendor_period_snapshot (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  vendor_id             UUID NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  run_id                UUID REFERENCES reconciliation_run(id) ON DELETE SET NULL,

  period                gst_period NOT NULL,
  risk_score            SMALLINT NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  risk_band             risk_band NOT NULL,

  itc_exposure_paise    BIGINT NOT NULL DEFAULT 0,
  itc_at_risk_paise     BIGINT NOT NULL DEFAULT 0,
  books_line_count      INTEGER NOT NULL DEFAULT 0 CHECK (books_line_count >= 0),
  missing_from_2b_count INTEGER NOT NULL DEFAULT 0 CHECK (missing_from_2b_count >= 0),
  had_rule_37a          BOOLEAN NOT NULL DEFAULT FALSE,

  -- Derived, stored for query speed. NULL on a vendor's first period,
  -- which is the honest answer rather than a fabricated 'STABLE'.
  trend                 vendor_trend NOT NULL DEFAULT 'NEW',
  trend_delta_score     SMALLINT,
  consecutive_flagged   SMALLINT NOT NULL DEFAULT 0,

  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT missing_within_total CHECK (missing_from_2b_count <= books_line_count),
  -- Re-reconciling a corrected file updates the period in place rather
  -- than double-counting it into the vendor's track record.
  UNIQUE (tenant_id, vendor_id, period)
);

CREATE INDEX ON vendor_period_snapshot (tenant_id, vendor_id, period DESC);

-- ---------------------------------------------------------------------
-- Chase tracking
-- ---------------------------------------------------------------------

CREATE TABLE chase_message (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  vendor_id      UUID NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  period         gst_period NOT NULL,

  channel        TEXT NOT NULL CHECK (channel IN ('EMAIL', 'WHATSAPP', 'OTHER')),
  sent_at        TIMESTAMPTZ,
  sent_by        UUID REFERENCES app_user(id) ON DELETE SET NULL,
  amount_at_stake_paise BIGINT NOT NULL DEFAULT 0,
  vendor_replied_at     TIMESTAMPTZ,
  resolved_at           TIMESTAMPTZ,
  notes          TEXT,

  UNIQUE (tenant_id, vendor_id, period, channel)
);

CREATE INDEX ON chase_message (tenant_id, period) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------
-- Audit log
--
-- Append-only by policy below. A tool whose whole value is being
-- trustworthy about money needs to answer "who changed what, when"
-- without relying on anyone's memory.
-- ---------------------------------------------------------------------

CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID REFERENCES tenant(id) ON DELETE SET NULL,
  actor_id      UUID REFERENCES app_user(id) ON DELETE SET NULL,
  actor_email   TEXT,          -- denormalised: survives user deletion
  action        TEXT NOT NULL, -- 'login.success', 'run.create', 'payment_file.export', ...
  entity_type   TEXT,
  entity_id     UUID,
  ip_address    INET,
  user_agent    TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}',
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX ON audit_log (action, occurred_at DESC);

-- ---------------------------------------------------------------------
-- Row-level security
--
-- The single most important block in this file. Without RLS, one
-- forgotten `WHERE tenant_id = ...` in application code leaks one
-- customer's entire purchase ledger to another. With it, the database
-- refuses regardless of what the application asks for.
--
-- The app must connect as a NON-superuser role and set
--   SET LOCAL app.current_tenant = '<uuid>';
-- at the start of each transaction. Superusers and table owners bypass
-- RLS, so the application role must be neither.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant', TRUE), '')::UUID
$$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'vendor', 'reconciliation_run', 'purchase_record', 'gstr2b_record',
    'match_result', 'risk_finding', 'payhold_decision',
    'vendor_period_snapshot', 'chase_message'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id())
         WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- The audit log is readable within a tenant but never rewritable: no
-- UPDATE or DELETE policy is created, so those are denied by default.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read   ON audit_log FOR SELECT USING (tenant_id = current_tenant_id());
CREATE POLICY audit_append ON audit_log FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------
-- Convenience views
-- ---------------------------------------------------------------------

-- Latest run per period, which is almost always what a report wants.
CREATE VIEW latest_run_per_period AS
SELECT DISTINCT ON (tenant_id, period) *
FROM reconciliation_run
WHERE is_sample = FALSE
ORDER BY tenant_id, period, created_at DESC;

-- Vendors whose credit has been at risk for three or more consecutive
-- periods: the repeat offenders worth a hard conversation.
CREATE VIEW repeat_offender AS
SELECT v.id AS vendor_id, v.tenant_id, v.name, v.gstin,
       s.period, s.risk_score, s.risk_band, s.consecutive_flagged,
       s.itc_at_risk_paise
FROM vendor_period_snapshot s
JOIN vendor v ON v.id = s.vendor_id
WHERE s.consecutive_flagged >= 3
ORDER BY s.itc_at_risk_paise DESC;

COMMIT;

-- =====================================================================
-- Operational notes
--
-- 1. Create a dedicated application role that is NOT the table owner
--    and NOT a superuser, or RLS above is silently bypassed:
--
--      CREATE ROLE itcguard_app LOGIN PASSWORD '<from a secret manager>';
--      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO itcguard_app;
--      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO itcguard_app;
--      REVOKE DELETE, UPDATE ON audit_log FROM itcguard_app;
--
-- 2. Every request must open its transaction with
--      SET LOCAL app.current_tenant = '<tenant uuid>';
--    LOCAL matters: it resets at commit, so a pooled connection cannot
--    carry one tenant's identity into the next tenant's request.
--
-- 3. Enable encryption at rest at the volume level, and TLS in transit
--    (sslmode=require at minimum). vendor.bank_account_number and
--    app_user.password_hash are the columns that most justify it.
--
-- 4. Retention: purchase_record and gstr2b_record are the bulky, most
--    sensitive tables. vendor_period_snapshot is tiny and is the part
--    worth keeping for years. Consider dropping raw source rows after
--    the statutory retention period while keeping the snapshots.
-- =====================================================================
