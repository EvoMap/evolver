'use strict';

// Regression guard for evolver#544 default-mode follow-up.
//
// a2aProtocol.pokeHeartbeat is the wake-up vector that lets a stuck
// default-mode node recover when the user is actively driving the agent.
// The proxy-mode equivalent gets poked by HTTP middleware on every
// inbound request (see src/proxy/server/http.js#176-179 and the
// proxyHttpPokesLifecycle test). Default mode has no local HTTP surface,
// so the next-best user-activity signal is the evolve cycle itself.
//
// This test verifies the wiring at the SOURCE level rather than trying
// to spin up a real cycle: the loop body is daemon-coupled and not
// economically testable in isolation. The wiring is short, idempotent,
// and defensive (typeof guard for the obfuscated dist), so a structural
// check covers the regression we actually care about: "the poke is
// called once per cycle entry, with the typeof guard, in a swallowed
// try/catch so a buggy poke can never crash the daemon."

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const indexPath = path.resolve(__dirname, '..', 'index.js');
const source = fs.readFileSync(indexPath, 'utf8');

describe('index.js wires a2a.pokeHeartbeat into evolve cycle entry (#544)', () => {
  it('calls pokeHeartbeat at the top of the daemon loop iteration', () => {
    // The poke must appear inside the `while (true)` loop body, after
    // cycleCount increments but before the solidify gate / evolve.run().
    assert.match(
      source,
      /cycleCount \+= 1;[\s\S]{0,2000}?if \(typeof a2aPoke\.pokeHeartbeat === 'function'\) a2aPoke\.pokeHeartbeat\(\);[\s\S]{0,400}?Ralph-loop gating/,
      'pokeHeartbeat must be called between cycleCount increment and the Ralph-loop solidify gate'
    );
  });

  it('also pokes on the single-run path (node index.js run without --loop)', () => {
    assert.match(
      source,
      /\/\/ Normal Single Run[\s\S]{0,400}?if \(typeof a2aPoke\.pokeHeartbeat === 'function'\) a2aPoke\.pokeHeartbeat\(\);[\s\S]{0,200}?await evolve\.run\(\);/,
      'single-run path must call pokeHeartbeat before evolve.run()'
    );
  });

  it('guards every poke with typeof === function (obfuscated dist may not export it yet)', () => {
    // Count: there should be at least 2 typeof-guarded pokes (loop + single-run).
    const matches = source.match(
      /typeof a2aPoke\.pokeHeartbeat === 'function'/g
    ) || [];
    assert.ok(
      matches.length >= 2,
      `expected >= 2 typeof-guarded pokeHeartbeat call sites, found ${matches.length}`
    );
  });

  it('wraps every poke in try/catch so a buggy poke cannot crash the daemon', () => {
    // Each `if (typeof a2aPoke.pokeHeartbeat ...` line must be inside a
    // try block paired with a catch that swallows. We match the exact
    // pattern used in both sites: the `try { const a2aPoke = require...`
    // form. There must be at least 2.
    const tryPokeRegex =
      /try \{\s*const a2aPoke = require\('\.\/src\/gep\/a2aProtocol'\);\s*if \(typeof a2aPoke\.pokeHeartbeat === 'function'\) a2aPoke\.pokeHeartbeat\(\);\s*\} catch \{[^}]*\}/g;
    const matches = source.match(tryPokeRegex) || [];
    assert.ok(
      matches.length >= 2,
      `expected >= 2 try/catch-wrapped poke blocks, found ${matches.length}`
    );
  });
});
