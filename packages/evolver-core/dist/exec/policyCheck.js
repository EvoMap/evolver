// Back-compat shim: the per-gene constraint checker moved into ./policy/ when the v1 policyCheck safety core
// was ported as split modules (blast hard cap + protected paths + destructive + failure classification, all
// behind the single checkPolicy entry point). Existing imports of checkChangeConstraints / pathIsForbidden /
// summarizeViolations / ChangeConstraints / PolicyViolation keep working through this re-export — and the
// full policy core is available from ./policy/index.ts (re-exported here too via checkPolicy).
export { checkChangeConstraints, pathIsForbidden, summarizeViolations, } from './policy/constraints.js';
export { checkPolicy } from './policy/index.js';