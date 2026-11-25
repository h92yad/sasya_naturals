'use strict';

const { runVerifyHydration } = require('./verify_hydration');
const { runVerifyDatabase } = require('./verify_database');
const { runVerifyCheckoutMath } = require('./verify_checkout_math');
const { runVerifyRbacAndAudit } = require('./verify_rbac_and_audit');
const { runVerifyContentGuardian } = require('./verify_content_guardian');
const { runVerifySchemaPurity } = require('./verify_schema_purity');
const { runVerifyFootprintAndCadence } = require('./verify_footprint_and_cadence');

function runAllGates() {
  console.log('==================================================================');
  console.log('Sashya Naturals (sashyanaturals.com) — 7-Suite Guardrail Verification');
  console.log('==================================================================');
  runVerifyHydration();
  runVerifyDatabase();
  runVerifyCheckoutMath();
  runVerifyRbacAndAudit();
  runVerifyContentGuardian();
  runVerifySchemaPurity();
  runVerifyFootprintAndCadence();
  console.log('==================================================================');
  console.log('ALL 7/7 GUARDRAIL VERIFICATION SUITES PASSED (100% GREEN)');
  console.log('==================================================================');
}

if (require.main === module) {
  runAllGates();
}

module.exports = { runAllGates };
