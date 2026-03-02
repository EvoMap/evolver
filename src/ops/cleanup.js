// GEP Artifact Cleanup - Evolver Core Module
// Removes old gep_prompt_*.json/txt files from evolution dir.
// Keeps at least 10 most recent files regardless of age.

const fs = require('fs');
const path = require('path');
const { getEvolutionDir } = require('../gep/paths');

var MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
var MIN_KEEP = 10;

function safeBatchDelete(batch) {
    var deleted = 0;
    for (var i = 0; i < batch.length; i++) {
        try { fs.unlinkSync(batch[i]); deleted++; } catch (_) {}
    }
    return deleted;
}

function run() {
    var evoDir = getEvolutionDir();
    if (!fs.existsSync(evoDir)) return;

    var files = fs.readdirSync(evoDir)
        .filter(function(f) { return /^gep_prompt_.*\.(json|txt)$/.test(f); })
        .map(function(f) {
            var full = path.join(evoDir, f);
            var stat = fs.statSync(full);
            return { name: f, path: full, mtime: stat.mtimeMs };
        })
        .sort(function(a, b) { return b.mtime - a.mtime; }); // newest first

    var now = Date.now();
    var deleted = 0;

    // Phase 1: Age-based cleanup (keep at least MIN_KEEP)
    var filesToDelete = [];
    for (var i = MIN_KEEP; i < files.length; i++) {
        if (now - files[i].mtime > MAX_AGE_MS) {
            filesToDelete.push(files[i].path);
        }
    }

    if (filesToDelete.length > 0) {
        deleted += safeBatchDelete(filesToDelete);
    }

    // Phase 2: Size-based safety cap (keep max 10 files total)
    try {
        var remainingFiles = fs.readdirSync(evoDir)
            .filter(function(f) { return /^gep_prompt_.*\.(json|txt)$/.test(f); })
            .map(function(f) {
                var full = path.join(evoDir, f);
                var stat = fs.statSync(full);
                return { name: f, path: full, mtime: stat.mtimeMs };
            })
            .sort(function(a, b) { return b.mtime - a.mtime; }); // newest first

        var MAX_FILES = 10;
        if (remainingFiles.length > MAX_FILES) {
            var toDelete = remainingFiles.slice(MAX_FILES).map(function(f) { return f.path; });
            deleted += safeBatchDelete(toDelete);
        }
    } catch (e) {
        console.warn('[Cleanup] Phase 2 failed:', e.message);
    }

    if (deleted > 0) {
        console.log('[Cleanup] Deleted ' + deleted + ' old GEP artifacts.');
    }
    return deleted;
}

if (require.main === module) {
    console.log('[Cleanup] Scanning for old artifacts...');
    var count = run();
    console.log('[Cleanup] ' + (count > 0 ? 'Deleted ' + count + ' files.' : 'No files to delete.'));
}

module.exports = { run };
