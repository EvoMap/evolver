// Usage: node scripts/validate-modules.js ./src/evolve ./src/gep/solidify
// Requires each module to verify it loads without errors.
const modules = process.argv.slice(2);
if (!modules.length) { console.error('No modules specified'); process.exit(1); }
for (const m of modules) { require(m); }
console.log('ok');
