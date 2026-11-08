import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
const MAX_RECORD_BYTES = 64 * 1024;
const SITE_PACKAGES_PARENT = /^(?:python|pypy)\d/;
const SETUPTOOLS_FINDER = /^__editable___.+_finder\.py$/;
const FINDER_MAPPING = /^MAPPING\s*(?::[^=\n]*)?=\s*\{(.*)\}\s*$/m;
const QUOTED_PAIR = /'([^'\\]*)'\s*:\s*'([^'\\]*)'/g;
function pathIsWithin(root, target) {
    const rel = relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function listing(dir) {
    try {
        return readdirSync(dir);
    }
    catch {
        return [];
    }
}
function sitePackagesDirs(venv) {
    const lib = join(venv, 'lib');
    return listing(lib).filter((name) => SITE_PACKAGES_PARENT.test(name)).map((name) => join(lib, name, 'site-packages'));
}
function smallFile(path) {
    const stat = lstatSync(path);
    return stat.isFile() && stat.size <= MAX_RECORD_BYTES ? readFileSync(path, 'utf8') : undefined;
}
/** `.pth` path lines; `import` lines run code instead and are what setuptools uses to install its finder. */
function pthEntries(text) {
    return text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && !/^import[ \t]/.test(line));
}
/** setuptools' finder maps each top-level name to its package directory or module file. */
function finderEntries(text) {
    const mapping = FINDER_MAPPING.exec(text)?.[1] ?? '';
    return [...mapping.matchAll(QUOTED_PAIR)].map((match) => dirname(match[2]));
}
function canonical(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return resolve(path);
    }
}
/** Import roots, relative to the source checkout, that the venv's editable installs add to `sys.path`. */
export function editableImportRoots(venv, sourceRoot) {
    const root = canonical(sourceRoot);
    const out = new Set();
    for (const dir of sitePackagesDirs(venv)) {
        for (const name of listing(dir)) {
            const parse = name.endsWith('.pth') ? pthEntries : SETUPTOOLS_FINDER.test(name) ? finderEntries : undefined;
            const text = parse && smallFile(join(dir, name));
            if (!parse || !text)
                continue;
            for (const entry of parse(text).filter(isAbsolute).map(canonical)) {
                if (pathIsWithin(root, entry))
                    out.add(relative(root, entry));
            }
        }
    }
    return [...out];
}
/**
 * Editable installs record absolute paths into the checkout they were installed from, so a venv mirrored into a
 * verification copy would import the original sources. Returns the same locations inside the copy, which go on
 * PYTHONPATH ahead of site-packages.
 */
export function editableSourcesInCopy(venv, sourceRoot, copyRoot) {
    return editableImportRoots(venv, sourceRoot).map((root) => join(copyRoot, root));
}