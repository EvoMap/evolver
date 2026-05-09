'use strict';

function getSafetyState() {
  return {
    autobuyEnabled: isEnabled(process.env.EVOLVER_ATP_AUTOBUY) || isEnabled(process.env.ATP_AUTOBUY),
    dailyCreditCap: numberEnv('ATP_AUTOBUY_DAILY_CAP_CREDITS', 0),
    perOrderCreditCap: numberEnv('ATP_AUTOBUY_PER_ORDER_CAP_CREDITS', 0),
    autoPublishEnabled: isEnabled(process.env.EVOLVER_AUTO_PUBLISH),
    validatorEnabled: isEnabled(process.env.EVOLVER_VALIDATOR_ENABLED),
    traceLevel: String(process.env.EVOLVER_TRACE_LEVEL || 'minimal'),
    defaultVisibility: process.env.EVOLVER_DEFAULT_VISIBILITY || 'private',
    safeMode: isSafeMode(),
    warnings: getWarnings(),
  };
}

function isSafeMode() {
  const state = {
    autobuyEnabled: isEnabled(process.env.EVOLVER_ATP_AUTOBUY) || isEnabled(process.env.ATP_AUTOBUY),
    dailyCreditCap: numberEnv('ATP_AUTOBUY_DAILY_CAP_CREDITS', 0),
    perOrderCreditCap: numberEnv('ATP_AUTOBUY_PER_ORDER_CAP_CREDITS', 0),
    autoPublishEnabled: isEnabled(process.env.EVOLVER_AUTO_PUBLISH),
    validatorEnabled: isEnabled(process.env.EVOLVER_VALIDATOR_ENABLED),
  };
  return !state.autobuyEnabled &&
    state.dailyCreditCap === 0 &&
    state.perOrderCreditCap === 0 &&
    !state.autoPublishEnabled &&
    !state.validatorEnabled;
}

function getWarnings() {
  const warnings = [];
  if (isEnabled(process.env.EVOLVER_ATP_AUTOBUY) || isEnabled(process.env.ATP_AUTOBUY)) {
    warnings.push('ATP autobuy is enabled.');
  }
  if (numberEnv('ATP_AUTOBUY_DAILY_CAP_CREDITS', 0) > 0) {
    warnings.push('Daily ATP autobuy credit cap is above zero.');
  }
  if (numberEnv('ATP_AUTOBUY_PER_ORDER_CAP_CREDITS', 0) > 0) {
    warnings.push('Per-order ATP autobuy credit cap is above zero.');
  }
  if (isEnabled(process.env.EVOLVER_AUTO_PUBLISH)) warnings.push('Auto-publish is enabled.');
  if (isEnabled(process.env.EVOLVER_VALIDATOR_ENABLED)) warnings.push('Validator daemon is enabled.');
  return warnings;
}

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function numberEnv(key, fallback) {
  const n = Number(process.env[key]);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = { getSafetyState };
