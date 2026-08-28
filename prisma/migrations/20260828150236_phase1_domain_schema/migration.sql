-- CreateEnum
CREATE TYPE "Role" AS ENUM ('DRIVER', 'TECHNICIAN', 'DISPATCHER', 'FLEET_MANAGER');

-- CreateEnum
CREATE TYPE "TenantKind" AS ENUM ('FLEET', 'CONSUMER');

-- CreateEnum
CREATE TYPE "ContractTierName" AS ENUM ('GOLD', 'SILVER', 'BRONZE', 'NONE');

-- CreateEnum
CREATE TYPE "UnitKind" AS ENUM ('VAN', 'BIKE', 'FLATBED_TOW', 'WHEEL_LIFT_TOW');

-- CreateEnum
CREATE TYPE "UnitStatus" AS ENUM ('AVAILABLE', 'HELD', 'ON_JOB', 'MAINTENANCE', 'OFFLINE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('DRAFT', 'INTAKE', 'PLANNED', 'OFFERED', 'COMMITTED', 'EN_ROUTE', 'ON_SITE', 'DIAGNOSING', 'WORKING', 'AWAITING_DESTINATION', 'TOWING', 'RESOLVED', 'UNSERVICEABLE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SafetyLevel" AS ENUM ('NORMAL', 'ELEVATED', 'HIGH_RISK');

-- CreateEnum
CREATE TYPE "RoadPosition" AS ENUM ('SHOULDER', 'LANE', 'SERVICE_ROAD', 'PARKING');

-- CreateEnum
CREATE TYPE "HoldStatus" AS ENUM ('ACTIVE', 'RELEASED', 'EXPIRED', 'CONSUMED');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'DECLINED', 'TIMEOUT', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "SagaState" AS ENUM ('PROPOSED', 'AWAITING_LEGS', 'ALL_ACCEPTED', 'COMMITTED', 'RELEASED_ALL', 'REQUEUED');

-- CreateEnum
CREATE TYPE "ActionTier" AS ENUM ('AUTO', 'RECOMMEND', 'APPROVE');

-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('PENDING', 'EXECUTED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'UPI', 'CASH', 'CONTRACT');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'AUTHORISED', 'CAPTURED', 'REFUNDED', 'FAILED');

-- CreateEnum
CREATE TYPE "EstimateStatus" AS ENUM ('DRAFT', 'SENT', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "HealthState" AS ENUM ('NORMAL', 'DEGRADED', 'CRITICAL');

-- CreateEnum
CREATE TYPE "EscalationStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "PromotionKind" AS ENUM ('LOCATION_CORRECTION', 'ACCESS_RESTRICTION', 'SAFETY_CHANGE', 'DIAGNOSIS_DETAIL');

-- CreateEnum
CREATE TYPE "PromotionStatus" AS ENUM ('FLAGGED', 'CONFIRMED', 'REJECTED');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "TenantKind" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_memberships" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "tier_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_tiers" (
    "id" TEXT NOT NULL,
    "name" "ContractTierName" NOT NULL,
    "description" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "contract_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_policies" (
    "id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "service_type" TEXT NOT NULL,
    "response_minutes" INTEGER NOT NULL,
    "resolution_minutes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "covered_services" (
    "id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "service_type" TEXT NOT NULL,
    "covered" BOOLEAN NOT NULL DEFAULT true,
    "cap_paise" INTEGER,

    CONSTRAINT "covered_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drivers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "home_zone_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_profiles" (
    "id" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year_from" INTEGER NOT NULL,
    "year_to" INTEGER NOT NULL,
    "body_type" TEXT NOT NULL,
    "fuel_type" TEXT NOT NULL,
    "ev_class" TEXT,
    "key_type" TEXT NOT NULL,
    "notes" TEXT,

    CONSTRAINT "vehicle_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "profile_id" TEXT NOT NULL,
    "registration" TEXT NOT NULL,
    "colour" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zones" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "centroid_lat" DOUBLE PRECISION NOT NULL,
    "centroid_lng" DOUBLE PRECISION NOT NULL,
    "boundary" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capabilities" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technicians" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "home_zone_id" TEXT,
    "employee_code" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rating_bps" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "technicians_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technician_capability" (
    "id" TEXT NOT NULL,
    "technician_id" TEXT NOT NULL,
    "capability_id" TEXT NOT NULL,
    "certified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "cert_ref" TEXT,

    CONSTRAINT "technician_capability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technician_shifts" (
    "id" TEXT NOT NULL,
    "technician_id" TEXT NOT NULL,
    "zone_id" TEXT,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "technician_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "UnitKind" NOT NULL,
    "zone_id" TEXT NOT NULL,
    "status" "UnitStatus" NOT NULL DEFAULT 'AVAILABLE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "current_technician_id" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "last_location_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_capability" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "capability_id" TEXT NOT NULL,

    CONSTRAINT "unit_capability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_status_history" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "from_status" "UnitStatus",
    "to_status" "UnitStatus" NOT NULL,
    "reason" TEXT,
    "job_id" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "driver_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "zone_id" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'DRAFT',
    "safety_level" "SafetyLevel" NOT NULL DEFAULT 'NORMAL',
    "service_type" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "assigned_unit_id" TEXT,
    "assigned_technician_id" TEXT,
    "price_list_id" TEXT,
    "sla_policy_id" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "heading_degrees" INTEGER,
    "carriageway_direction" TEXT,
    "nearest_exit" TEXT,
    "km_marker" TEXT,
    "landmark" TEXT,
    "road_position" "RoadPosition",
    "parking_level" TEXT,
    "on_highway" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_events" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "actor_role" TEXT,
    "actor_id" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "symptom_reports" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'STRUCTURED',
    "payload" JSONB NOT NULL,
    "raw_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "symptom_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fault_hypotheses" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "distribution" JSONB NOT NULL,
    "required_capability_codes" TEXT[],
    "entropy" DOUBLE PRECISION NOT NULL,
    "top_fault" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fault_hypotheses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intake_questions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "answer_type" TEXT NOT NULL,
    "faults_addressed" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "intake_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intake_answers" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "question_id" TEXT,
    "question_code" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "entropy_before" DOUBLE PRECISION NOT NULL,
    "entropy_after" DOUBLE PRECISION NOT NULL,
    "expected_gain" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intake_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_events" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "heading_degrees" INTEGER,
    "accuracy_metres" DOUBLE PRECISION,
    "source" TEXT NOT NULL,
    "event_time" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eta_estimates" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "unit_id" TEXT,
    "technician_id" TEXT,
    "eta_seconds" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eta_estimates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "completion_verifications" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'CODE',
    "result" TEXT,
    "verifier_role" TEXT,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "completion_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "solver_runs" (
    "id" TEXT NOT NULL,
    "job_id" TEXT,
    "trigger" TEXT NOT NULL,
    "snapshot_hash" TEXT NOT NULL,
    "option_count" INTEGER NOT NULL,
    "feasible_count" INTEGER NOT NULL,
    "rejected" JSONB NOT NULL DEFAULT '[]',
    "wall_clock_ms" INTEGER NOT NULL,
    "zone_partitioned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "solver_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_options" (
    "id" TEXT NOT NULL,
    "solver_run_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "technician_id" TEXT NOT NULL,
    "estimated_travel_minutes" DOUBLE PRECISION NOT NULL,
    "covered_fault_probability" DOUBLE PRECISION NOT NULL,
    "missing_capabilities" TEXT[],
    "feasible" BOOLEAN NOT NULL DEFAULT true,
    "rejection_code" TEXT,
    "rejection_detail" TEXT,
    "cost_breakdown" JSONB,
    "total_cost" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_variants" (
    "id" TEXT NOT NULL,
    "solver_run_id" TEXT NOT NULL,
    "job_id" TEXT,
    "label" TEXT NOT NULL,
    "assignments" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "total_cost" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_offers" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "plan_variant_id" TEXT,
    "unit_id" TEXT,
    "technician_id" TEXT,
    "state" "SagaState" NOT NULL DEFAULT 'PROPOSED',
    "version" INTEGER NOT NULL DEFAULT 0,
    "proposed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dispatch_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_holds" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "dispatch_offer_id" TEXT,
    "status" "HoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "held_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "released_at" TIMESTAMP(3),
    "release_reason" TEXT,

    CONSTRAINT "unit_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technician_offers" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "technician_id" TEXT NOT NULL,
    "dispatch_offer_id" TEXT,
    "status" "OfferStatus" NOT NULL DEFAULT 'PROPOSED',
    "version" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "responded_at" TIMESTAMP(3),
    "response_latency_ms" INTEGER,

    CONSTRAINT "technician_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_records" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "solver_run_id" TEXT,
    "selected_option_id" TEXT,
    "selected_by_role" TEXT,
    "selected_by_id" TEXT,
    "override_reason_code" TEXT,
    "cost_breakdown" JSONB NOT NULL DEFAULT '{}',
    "rejected_alternatives" JSONB NOT NULL DEFAULT '[]',
    "covered_fault_probability" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_categories" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" TEXT,

    CONSTRAINT "part_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parts" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'EACH',
    "hazmat" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "depots" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "zone_id" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,

    CONSTRAINT "depots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_stock" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "part_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unit_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT,
    "depot_id" TEXT,
    "part_id" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "job_id" TEXT,
    "ref_id" TEXT,
    "event_time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_confirmations" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "technician_id" TEXT NOT NULL,
    "part_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restock_orders" (
    "id" TEXT NOT NULL,
    "depot_id" TEXT,
    "unit_id" TEXT,
    "part_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_at" TIMESTAMP(3),

    CONSTRAINT "restock_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_lists" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tenant_id" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_prices" (
    "id" TEXT NOT NULL,
    "price_list_id" TEXT NOT NULL,
    "part_id" TEXT NOT NULL,
    "unit_price_paise" INTEGER NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3),

    CONSTRAINT "part_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour_rates" (
    "id" TEXT NOT NULL,
    "price_list_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "rate_per_hour_paise" INTEGER NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3),

    CONSTRAINT "labour_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tow_tariffs" (
    "id" TEXT NOT NULL,
    "price_list_id" TEXT NOT NULL,
    "tow_type" TEXT NOT NULL,
    "per_km_paise" INTEGER NOT NULL,
    "min_charge_paise" INTEGER NOT NULL DEFAULT 0,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3),

    CONSTRAINT "tow_tariffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "callout_fees" (
    "id" TEXT NOT NULL,
    "price_list_id" TEXT NOT NULL,
    "service_type" TEXT NOT NULL,
    "fee_paise" INTEGER NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3),

    CONSTRAINT "callout_fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount_paise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "idempotency_key" TEXT NOT NULL,
    "external_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "event_time" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authorisations" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "external_ref" TEXT,
    "authorised_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authorisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "captures" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "external_ref" TEXT,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "captures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "reason" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "external_ref" TEXT,
    "refunded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimates" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "price_list_id" TEXT,
    "status" "EstimateStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal_paise" INTEGER NOT NULL DEFAULT 0,
    "tax_paise" INTEGER NOT NULL DEFAULT 0,
    "total_paise" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "estimates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimate_lines" (
    "id" TEXT NOT NULL,
    "estimate_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unit_price_paise" INTEGER NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "ref_id" TEXT,

    CONSTRAINT "estimate_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimate_approvals" (
    "id" TEXT NOT NULL,
    "estimate_id" TEXT NOT NULL,
    "approved_by_role" TEXT NOT NULL,
    "approved_by_id" TEXT,
    "channel" TEXT,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "estimate_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "job_id" TEXT,
    "memo" TEXT,
    "event_time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commissions" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "technician_id" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "rate_bps" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ACCRUED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "technician_id" TEXT NOT NULL,
    "batch_id" TEXT,
    "amount_paise" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_batches" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "total_paise" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "payout_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_collections" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "technician_id" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "reconciled" BOOLEAN NOT NULL DEFAULT false,
    "collected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_billings" (
    "id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_billings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workshops" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "zone_id" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "ev_class" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workshops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workshop_capabilities" (
    "id" TEXT NOT NULL,
    "workshop_id" TEXT NOT NULL,
    "capability_code" TEXT NOT NULL,
    "notes" TEXT,

    CONSTRAINT "workshop_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workshop_authorisations" (
    "id" TEXT NOT NULL,
    "workshop_id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'STANDARD',
    "valid_from" TIMESTAMP(3),
    "valid_to" TIMESTAMP(3),

    CONSTRAINT "workshop_authorisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workshop_hours" (
    "id" TEXT NOT NULL,
    "workshop_id" TEXT NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "opens" TEXT NOT NULL,
    "closes" TEXT NOT NULL,
    "closed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "workshop_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "destination_offers" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "workshop_id" TEXT NOT NULL,
    "dispatch_offer_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "eta_seconds" INTEGER,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "responded_at" TIMESTAMP(3),

    CONSTRAINT "destination_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acceptance_outcomes" (
    "id" TEXT NOT NULL,
    "destination_offer_id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acceptance_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_requests" (
    "id" TEXT NOT NULL,
    "job_id" TEXT,
    "tier" "ActionTier" NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "computed_impact" JSONB,
    "status" "ActionStatus" NOT NULL DEFAULT 'PENDING',
    "resolution" TEXT,
    "requested_by_role" TEXT,
    "requested_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "action_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_records" (
    "id" TEXT NOT NULL,
    "action_request_id" TEXT NOT NULL,
    "approved_by_role" TEXT NOT NULL,
    "approved_by_id" TEXT,
    "decision" TEXT NOT NULL,
    "note" TEXT,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalations" (
    "id" TEXT NOT NULL,
    "job_id" TEXT,
    "reason" TEXT NOT NULL,
    "status" "EscalationStatus" NOT NULL DEFAULT 'OPEN',
    "reassignment_count" INTEGER NOT NULL DEFAULT 0,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "escalations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalation_decisions" (
    "id" TEXT NOT NULL,
    "escalation_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "note" TEXT,
    "decided_by_role" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escalation_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_health_states" (
    "id" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "state" "HealthState" NOT NULL DEFAULT 'NORMAL',
    "detail" TEXT,
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_health_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "sender_role" TEXT NOT NULL,
    "sender_id" TEXT,
    "body" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TEXT',
    "event_time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_deliveries" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "message_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "size_bytes" INTEGER,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_promotions" (
    "id" TEXT NOT NULL,
    "message_id" TEXT,
    "job_id" TEXT NOT NULL,
    "kind" "PromotionKind" NOT NULL,
    "status" "PromotionStatus" NOT NULL DEFAULT 'FLAGGED',
    "proposed_payload" JSONB NOT NULL,
    "confirmed_by_role" TEXT,
    "confirmed_by_id" TEXT,
    "job_event_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "event_promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "job_id" TEXT,
    "recipient_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "coalesce_key" TEXT,
    "sent_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_events" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "sla_policy_id" TEXT,
    "kind" TEXT NOT NULL,
    "due_at" TIMESTAMP(3),
    "event_time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sla_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_role" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resource_id" TEXT,
    "tenant_id" TEXT,
    "cross_tenant" BOOLEAN NOT NULL DEFAULT false,
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "request_hash" TEXT,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_extractions" (
    "id" TEXT NOT NULL,
    "job_id" TEXT,
    "model" TEXT NOT NULL,
    "prompt" TEXT,
    "raw_response" JSONB,
    "extracted" JSONB,
    "confidence" DOUBLE PRECISION,
    "accepted" BOOLEAN,
    "event_time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_extractions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_memberships_user_id_idx" ON "tenant_memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_memberships_tenant_id_user_id_key" ON "tenant_memberships"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "contracts_tenant_id_idx" ON "contracts"("tenant_id");

-- CreateIndex
CREATE INDEX "sla_policies_contract_id_idx" ON "sla_policies"("contract_id");

-- CreateIndex
CREATE UNIQUE INDEX "covered_services_contract_id_service_type_key" ON "covered_services"("contract_id", "service_type");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_user_id_key" ON "drivers"("user_id");

-- CreateIndex
CREATE INDEX "drivers_tenant_id_idx" ON "drivers"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_profiles_make_model_year_from_year_to_key" ON "vehicle_profiles"("make", "model", "year_from", "year_to");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_registration_key" ON "vehicles"("registration");

-- CreateIndex
CREATE INDEX "vehicles_driver_id_idx" ON "vehicles"("driver_id");

-- CreateIndex
CREATE UNIQUE INDEX "zones_code_key" ON "zones"("code");

-- CreateIndex
CREATE UNIQUE INDEX "capabilities_code_key" ON "capabilities"("code");

-- CreateIndex
CREATE UNIQUE INDEX "technicians_user_id_key" ON "technicians"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "technicians_employee_code_key" ON "technicians"("employee_code");

-- CreateIndex
CREATE INDEX "technician_capability_capability_id_idx" ON "technician_capability"("capability_id");

-- CreateIndex
CREATE UNIQUE INDEX "technician_capability_technician_id_capability_id_key" ON "technician_capability"("technician_id", "capability_id");

-- CreateIndex
CREATE INDEX "technician_shifts_technician_id_starts_at_idx" ON "technician_shifts"("technician_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "units_code_key" ON "units"("code");

-- CreateIndex
CREATE UNIQUE INDEX "units_current_technician_id_key" ON "units"("current_technician_id");

-- CreateIndex
CREATE INDEX "units_zone_id_status_idx" ON "units"("zone_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "unit_capability_unit_id_capability_id_key" ON "unit_capability"("unit_id", "capability_id");

-- CreateIndex
CREATE INDEX "unit_status_history_unit_id_at_idx" ON "unit_status_history"("unit_id", "at");

-- CreateIndex
CREATE INDEX "jobs_status_created_at_idx" ON "jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "jobs_zone_id_status_idx" ON "jobs"("zone_id", "status");

-- CreateIndex
CREATE INDEX "jobs_tenant_id_idx" ON "jobs"("tenant_id");

-- CreateIndex
CREATE INDEX "job_events_job_id_sequence_idx" ON "job_events"("job_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "job_events_job_id_sequence_key" ON "job_events"("job_id", "sequence");

-- CreateIndex
CREATE INDEX "symptom_reports_job_id_idx" ON "symptom_reports"("job_id");

-- CreateIndex
CREATE INDEX "fault_hypotheses_job_id_created_at_idx" ON "fault_hypotheses"("job_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "intake_questions_code_key" ON "intake_questions"("code");

-- CreateIndex
CREATE INDEX "intake_answers_job_id_created_at_idx" ON "intake_answers"("job_id", "created_at");

-- CreateIndex
CREATE INDEX "location_events_job_id_event_time_idx" ON "location_events"("job_id", "event_time");

-- CreateIndex
CREATE INDEX "eta_estimates_job_id_computed_at_idx" ON "eta_estimates"("job_id", "computed_at");

-- CreateIndex
CREATE UNIQUE INDEX "completion_verifications_job_id_key" ON "completion_verifications"("job_id");

-- CreateIndex
CREATE INDEX "solver_runs_created_at_idx" ON "solver_runs"("created_at");

-- CreateIndex
CREATE INDEX "dispatch_options_job_id_idx" ON "dispatch_options"("job_id");

-- CreateIndex
CREATE INDEX "dispatch_options_solver_run_id_idx" ON "dispatch_options"("solver_run_id");

-- CreateIndex
CREATE INDEX "plan_variants_solver_run_id_idx" ON "plan_variants"("solver_run_id");

-- CreateIndex
CREATE INDEX "dispatch_offers_job_id_idx" ON "dispatch_offers"("job_id");

-- CreateIndex
CREATE INDEX "dispatch_offers_state_idx" ON "dispatch_offers"("state");

-- CreateIndex
CREATE INDEX "unit_holds_unit_id_status_idx" ON "unit_holds"("unit_id", "status");

-- CreateIndex
CREATE INDEX "unit_holds_expires_at_idx" ON "unit_holds"("expires_at");

-- CreateIndex
CREATE INDEX "technician_offers_status_expires_at_idx" ON "technician_offers"("status", "expires_at");

-- CreateIndex
CREATE INDEX "technician_offers_job_id_idx" ON "technician_offers"("job_id");

-- CreateIndex
CREATE INDEX "decision_records_job_id_created_at_idx" ON "decision_records"("job_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "part_categories_code_key" ON "part_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "parts_sku_key" ON "parts"("sku");

-- CreateIndex
CREATE INDEX "parts_category_id_idx" ON "parts"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "depots_code_key" ON "depots"("code");

-- CreateIndex
CREATE INDEX "unit_stock_part_id_idx" ON "unit_stock"("part_id");

-- CreateIndex
CREATE UNIQUE INDEX "unit_stock_unit_id_part_id_key" ON "unit_stock"("unit_id", "part_id");

-- CreateIndex
CREATE INDEX "stock_movements_part_id_event_time_idx" ON "stock_movements"("part_id", "event_time");

-- CreateIndex
CREATE INDEX "stock_confirmations_job_id_idx" ON "stock_confirmations"("job_id");

-- CreateIndex
CREATE INDEX "restock_orders_part_id_idx" ON "restock_orders"("part_id");

-- CreateIndex
CREATE INDEX "price_lists_valid_from_valid_to_idx" ON "price_lists"("valid_from", "valid_to");

-- CreateIndex
CREATE INDEX "part_prices_price_list_id_part_id_idx" ON "part_prices"("price_list_id", "part_id");

-- CreateIndex
CREATE INDEX "labour_rates_price_list_id_idx" ON "labour_rates"("price_list_id");

-- CreateIndex
CREATE INDEX "tow_tariffs_price_list_id_idx" ON "tow_tariffs"("price_list_id");

-- CreateIndex
CREATE INDEX "callout_fees_price_list_id_idx" ON "callout_fees"("price_list_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "payments_job_id_idx" ON "payments"("job_id");

-- CreateIndex
CREATE INDEX "payment_events_payment_id_idx" ON "payment_events"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "authorisations_payment_id_key" ON "authorisations"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "captures_idempotency_key_key" ON "captures"("idempotency_key");

-- CreateIndex
CREATE INDEX "captures_payment_id_idx" ON "captures"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_idempotency_key_key" ON "refunds"("idempotency_key");

-- CreateIndex
CREATE INDEX "refunds_payment_id_idx" ON "refunds"("payment_id");

-- CreateIndex
CREATE INDEX "estimates_job_id_idx" ON "estimates"("job_id");

-- CreateIndex
CREATE INDEX "estimate_lines_estimate_id_idx" ON "estimate_lines"("estimate_id");

-- CreateIndex
CREATE UNIQUE INDEX "estimate_approvals_estimate_id_key" ON "estimate_approvals"("estimate_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_code_key" ON "ledger_accounts"("code");

-- CreateIndex
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries"("transaction_id");

-- CreateIndex
CREATE INDEX "ledger_entries_account_id_created_at_idx" ON "ledger_entries"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "commissions_technician_id_idx" ON "commissions"("technician_id");

-- CreateIndex
CREATE INDEX "payouts_technician_id_idx" ON "payouts"("technician_id");

-- CreateIndex
CREATE INDEX "payouts_batch_id_idx" ON "payouts"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_batches_reference_key" ON "payout_batches"("reference");

-- CreateIndex
CREATE INDEX "cash_collections_technician_id_idx" ON "cash_collections"("technician_id");

-- CreateIndex
CREATE INDEX "contract_billings_contract_id_idx" ON "contract_billings"("contract_id");

-- CreateIndex
CREATE UNIQUE INDEX "workshops_code_key" ON "workshops"("code");

-- CreateIndex
CREATE UNIQUE INDEX "workshop_capabilities_workshop_id_capability_code_key" ON "workshop_capabilities"("workshop_id", "capability_code");

-- CreateIndex
CREATE UNIQUE INDEX "workshop_authorisations_workshop_id_brand_key" ON "workshop_authorisations"("workshop_id", "brand");

-- CreateIndex
CREATE UNIQUE INDEX "workshop_hours_workshop_id_day_of_week_key" ON "workshop_hours"("workshop_id", "day_of_week");

-- CreateIndex
CREATE INDEX "destination_offers_job_id_idx" ON "destination_offers"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "acceptance_outcomes_destination_offer_id_key" ON "acceptance_outcomes"("destination_offer_id");

-- CreateIndex
CREATE INDEX "action_requests_job_id_idx" ON "action_requests"("job_id");

-- CreateIndex
CREATE INDEX "action_requests_status_idx" ON "action_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "approval_records_action_request_id_key" ON "approval_records"("action_request_id");

-- CreateIndex
CREATE INDEX "escalations_job_id_idx" ON "escalations"("job_id");

-- CreateIndex
CREATE INDEX "escalations_status_idx" ON "escalations"("status");

-- CreateIndex
CREATE INDEX "escalation_decisions_escalation_id_idx" ON "escalation_decisions"("escalation_id");

-- CreateIndex
CREATE UNIQUE INDEX "system_health_states_component_key" ON "system_health_states"("component");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_job_id_key" ON "conversations"("job_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_event_time_idx" ON "messages"("conversation_id", "event_time");

-- CreateIndex
CREATE UNIQUE INDEX "message_deliveries_message_id_recipient_id_key" ON "message_deliveries"("message_id", "recipient_id");

-- CreateIndex
CREATE INDEX "attachments_message_id_idx" ON "attachments"("message_id");

-- CreateIndex
CREATE INDEX "event_promotions_job_id_idx" ON "event_promotions"("job_id");

-- CreateIndex
CREATE INDEX "notifications_recipient_id_created_at_idx" ON "notifications"("recipient_id", "created_at");

-- CreateIndex
CREATE INDEX "sla_events_job_id_event_time_idx" ON "sla_events"("job_id", "event_time");

-- CreateIndex
CREATE INDEX "audit_logs_resource_at_idx" ON "audit_logs"("resource", "at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_at_idx" ON "audit_logs"("actor_id", "at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_scope_key_key" ON "idempotency_keys"("user_id", "scope", "key");

-- CreateIndex
CREATE INDEX "ai_extractions_job_id_idx" ON "ai_extractions"("job_id");

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_tier_id_fkey" FOREIGN KEY ("tier_id") REFERENCES "contract_tiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "covered_services" ADD CONSTRAINT "covered_services_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_home_zone_id_fkey" FOREIGN KEY ("home_zone_id") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "vehicle_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technicians" ADD CONSTRAINT "technicians_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technicians" ADD CONSTRAINT "technicians_home_zone_id_fkey" FOREIGN KEY ("home_zone_id") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_capability" ADD CONSTRAINT "technician_capability_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_capability" ADD CONSTRAINT "technician_capability_capability_id_fkey" FOREIGN KEY ("capability_id") REFERENCES "capabilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_shifts" ADD CONSTRAINT "technician_shifts_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_shifts" ADD CONSTRAINT "technician_shifts_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_current_technician_id_fkey" FOREIGN KEY ("current_technician_id") REFERENCES "technicians"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_capability" ADD CONSTRAINT "unit_capability_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_capability" ADD CONSTRAINT "unit_capability_capability_id_fkey" FOREIGN KEY ("capability_id") REFERENCES "capabilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_status_history" ADD CONSTRAINT "unit_status_history_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assigned_unit_id_fkey" FOREIGN KEY ("assigned_unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assigned_technician_id_fkey" FOREIGN KEY ("assigned_technician_id") REFERENCES "technicians"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_sla_policy_id_fkey" FOREIGN KEY ("sla_policy_id") REFERENCES "sla_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "symptom_reports" ADD CONSTRAINT "symptom_reports_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fault_hypotheses" ADD CONSTRAINT "fault_hypotheses_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_answers" ADD CONSTRAINT "intake_answers_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_answers" ADD CONSTRAINT "intake_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "intake_questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_events" ADD CONSTRAINT "location_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eta_estimates" ADD CONSTRAINT "eta_estimates_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eta_estimates" ADD CONSTRAINT "eta_estimates_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "completion_verifications" ADD CONSTRAINT "completion_verifications_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solver_runs" ADD CONSTRAINT "solver_runs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_options" ADD CONSTRAINT "dispatch_options_solver_run_id_fkey" FOREIGN KEY ("solver_run_id") REFERENCES "solver_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_options" ADD CONSTRAINT "dispatch_options_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_options" ADD CONSTRAINT "dispatch_options_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_variants" ADD CONSTRAINT "plan_variants_solver_run_id_fkey" FOREIGN KEY ("solver_run_id") REFERENCES "solver_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_variants" ADD CONSTRAINT "plan_variants_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_offers" ADD CONSTRAINT "dispatch_offers_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_offers" ADD CONSTRAINT "dispatch_offers_plan_variant_id_fkey" FOREIGN KEY ("plan_variant_id") REFERENCES "plan_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_offers" ADD CONSTRAINT "dispatch_offers_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_holds" ADD CONSTRAINT "unit_holds_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_holds" ADD CONSTRAINT "unit_holds_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_holds" ADD CONSTRAINT "unit_holds_dispatch_offer_id_fkey" FOREIGN KEY ("dispatch_offer_id") REFERENCES "dispatch_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_offers" ADD CONSTRAINT "technician_offers_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_offers" ADD CONSTRAINT "technician_offers_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_offers" ADD CONSTRAINT "technician_offers_dispatch_offer_id_fkey" FOREIGN KEY ("dispatch_offer_id") REFERENCES "dispatch_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_solver_run_id_fkey" FOREIGN KEY ("solver_run_id") REFERENCES "solver_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_selected_option_id_fkey" FOREIGN KEY ("selected_option_id") REFERENCES "dispatch_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_categories" ADD CONSTRAINT "part_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "part_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parts" ADD CONSTRAINT "parts_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "part_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "depots" ADD CONSTRAINT "depots_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_stock" ADD CONSTRAINT "unit_stock_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_stock" ADD CONSTRAINT "unit_stock_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_depot_id_fkey" FOREIGN KEY ("depot_id") REFERENCES "depots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_confirmations" ADD CONSTRAINT "stock_confirmations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_confirmations" ADD CONSTRAINT "stock_confirmations_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restock_orders" ADD CONSTRAINT "restock_orders_depot_id_fkey" FOREIGN KEY ("depot_id") REFERENCES "depots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restock_orders" ADD CONSTRAINT "restock_orders_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restock_orders" ADD CONSTRAINT "restock_orders_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_prices" ADD CONSTRAINT "part_prices_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_prices" ADD CONSTRAINT "part_prices_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labour_rates" ADD CONSTRAINT "labour_rates_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tow_tariffs" ADD CONSTRAINT "tow_tariffs_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "callout_fees" ADD CONSTRAINT "callout_fees_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorisations" ADD CONSTRAINT "authorisations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "captures" ADD CONSTRAINT "captures_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_lines" ADD CONSTRAINT "estimate_lines_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_approvals" ADD CONSTRAINT "estimate_approvals_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "payout_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_collections" ADD CONSTRAINT "cash_collections_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_collections" ADD CONSTRAINT "cash_collections_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_billings" ADD CONSTRAINT "contract_billings_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workshops" ADD CONSTRAINT "workshops_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workshop_capabilities" ADD CONSTRAINT "workshop_capabilities_workshop_id_fkey" FOREIGN KEY ("workshop_id") REFERENCES "workshops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workshop_authorisations" ADD CONSTRAINT "workshop_authorisations_workshop_id_fkey" FOREIGN KEY ("workshop_id") REFERENCES "workshops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workshop_hours" ADD CONSTRAINT "workshop_hours_workshop_id_fkey" FOREIGN KEY ("workshop_id") REFERENCES "workshops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "destination_offers" ADD CONSTRAINT "destination_offers_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "destination_offers" ADD CONSTRAINT "destination_offers_workshop_id_fkey" FOREIGN KEY ("workshop_id") REFERENCES "workshops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "destination_offers" ADD CONSTRAINT "destination_offers_dispatch_offer_id_fkey" FOREIGN KEY ("dispatch_offer_id") REFERENCES "dispatch_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acceptance_outcomes" ADD CONSTRAINT "acceptance_outcomes_destination_offer_id_fkey" FOREIGN KEY ("destination_offer_id") REFERENCES "destination_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_requests" ADD CONSTRAINT "action_requests_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_records" ADD CONSTRAINT "approval_records_action_request_id_fkey" FOREIGN KEY ("action_request_id") REFERENCES "action_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalation_decisions" ADD CONSTRAINT "escalation_decisions_escalation_id_fkey" FOREIGN KEY ("escalation_id") REFERENCES "escalations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_promotions" ADD CONSTRAINT "event_promotions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_promotions" ADD CONSTRAINT "event_promotions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_events" ADD CONSTRAINT "sla_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_events" ADD CONSTRAINT "sla_events_sla_policy_id_fkey" FOREIGN KEY ("sla_policy_id") REFERENCES "sla_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_extractions" ADD CONSTRAINT "ai_extractions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- APPEND-ONLY ENFORCEMENT  (hand-written, not generated by Prisma)
--
-- Two tables in this schema are event logs: `job_events` (every state
-- transition) and `ledger_entries` (double-entry money). Their value is that
-- nobody can quietly rewrite history — so the *database itself* refuses UPDATE
-- and DELETE on them. A correction is a new compensating row, never an edit.
--
-- A trigger is used rather than only REVOKE because the table owner and any
-- superuser bypass table privileges, but not a BEFORE-ROW trigger that raises.
-- The REVOKE is kept as defence-in-depth for the non-privileged app role that
-- later phases connect as.
-- ============================================================================

CREATE OR REPLACE FUNCTION zippy_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not permitted', TG_TABLE_NAME, TG_OP
    USING HINT = 'write a new compensating row instead of changing an existing one';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_events_append_only
  BEFORE UPDATE OR DELETE ON "job_events"
  FOR EACH ROW EXECUTE FUNCTION zippy_reject_mutation();

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION zippy_reject_mutation();

REVOKE UPDATE, DELETE ON "job_events" FROM PUBLIC;
REVOKE UPDATE, DELETE ON "ledger_entries" FROM PUBLIC;
