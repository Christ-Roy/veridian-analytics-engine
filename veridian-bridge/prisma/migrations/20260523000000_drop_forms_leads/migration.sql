-- Drop Forms + Leads tables — sprint cleanup 2026-05-23
--
-- Scope change Robert : tracking de formulaires retiré du périmètre
-- commercialisé. Les goals staminads natifs couvrent ce besoin. On garde
-- la table Site (utilisée par settings + provision-existing-tenant pour
-- le tracking multi-domaines).
--
-- Migration DESTRUCTIVE : les données existantes seront perdues. Si tu lis
-- ça avant un déploiement prod : assure-toi qu'aucun client n'a de submissions
-- ou de leads en cours. En staging au 2026-05-23, ces tables sont vides
-- (Forms n'a jamais été utilisé en réel).
--
-- Rollback : voir 20260522000000_add_forms_leads/migration.sql (re-création
-- depuis zéro, données perdues définitivement).

-- DropForeignKey
ALTER TABLE "FormSubmission" DROP CONSTRAINT IF EXISTS "FormSubmission_siteId_fkey";
ALTER TABLE "FormSubmission" DROP CONSTRAINT IF EXISTS "FormSubmission_formSchemaId_fkey";
ALTER TABLE "FormSubmission" DROP CONSTRAINT IF EXISTS "FormSubmission_leadId_fkey";
ALTER TABLE "FormSchema" DROP CONSTRAINT IF EXISTS "FormSchema_siteId_fkey";
ALTER TABLE "Lead" DROP CONSTRAINT IF EXISTS "Lead_siteId_fkey";
ALTER TABLE "LeadSession" DROP CONSTRAINT IF EXISTS "LeadSession_leadId_fkey";

-- DropTable
DROP TABLE IF EXISTS "LeadSession";
DROP TABLE IF EXISTS "FormSubmission";
DROP TABLE IF EXISTS "Lead";
DROP TABLE IF EXISTS "FormSchema";
