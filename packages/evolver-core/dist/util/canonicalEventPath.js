import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, sep } from 'node:path';
/** Stable log identity before creation and through existing directory aliases. */
export function canonicalEventPath(value) {
    if (!value)
        throw new Error('invalid_recall_event_path');
    if (process.platform === 'win32' && value.startsWith('\\\\?\\')) {
        // libuv cannot realpath an extended drive root reliably. Normalize only
        // namespace spellings that have identical Win32 component semantics.
        const suffix = value.slice(4), share = suffix.slice(4).split('\\');
        const isUnc = suffix.slice(0, 4).toUpperCase() === 'UNC\\';
        if (isUnc && share.slice(0, 2).some(part => !part || part === '.' || part === '..' || part.includes('/') || /[<>:"|?*\\]|[. ]$/.test(part))) {
            throw new Error('invalid_recall_event_path');
        }
        const plain = /^[a-z]:[\\/]/i.test(suffix) ? suffix
            : isUnc && share.length >= 2 && share[0] && share[1]
                ? `\\\\${suffix.slice(4)}` : undefined;
        if (!plain)
            throw new Error('invalid_recall_event_path');
        const components = plain.slice(parse(plain).root.length).split(/[\\/]+/);
        if (components.some(part => part === '.' || part === '..' || part && (/[<>:"|?*]|[. ]$/.test(part)
            || /^(?:con(?:in\$|out\$)?|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))))
            throw new Error('invalid_recall_event_path');
        value = plain;
    }
    // path.resolve() folds `..` before the filesystem follows a preceding
    // symlink. That can bind a receipt to a different physical event log from
    // the one opened by readFile/open. Resolve each existing component first.
    if (process.platform === 'win32' && /^[a-z]:[^\\/]/i.test(value))
        throw new Error('invalid_recall_event_path');
    const input = isAbsolute(value) ? value : `${realpathSync(process.cwd())}${sep}${value}`;
    const root = parse(input).root;
    let ancestor = process.platform === 'win32' ? realpathSync.native(root) : realpathSync(root);
    const missing = [];
    const components = input.slice(root.length).split(process.platform === 'win32' ? /[\\/]+/ : sep);
    for (const component of components) {
        if (!component || component === '.')
            continue;
        if (component === '..') {
            // A missing component followed by `..` cannot be opened by the OS yet;
            // collapsing it would invent an authority for a different existing file.
            if (missing.length)
                throw new Error('invalid_recall_event_path');
            ancestor = join(ancestor, '..');
            continue;
        }
        if (missing.length) {
            missing.push(component);
            continue;
        }
        const candidate = join(ancestor, component);
        try {
            // Windows' JS realpath can preserve the caller's case spelling even for
            // the same file. Let the native filesystem resolve its actual name;
            // lowercasing would conflate distinct files in case-sensitive directories.
            ancestor = process.platform === 'win32' ? realpathSync.native(candidate) : realpathSync(candidate);
        }
        catch (error) {
            // Resolve aliases of existing ancestors even before the log is created.
            // Other failures cannot establish an identity and must fail closed.
            if (error.code !== 'ENOENT')
                throw error;
            // A dangling symlink is present, not a safely missing final component.
            try {
                lstatSync(candidate);
            }
            catch (missingError) {
                if (missingError.code !== 'ENOENT')
                    throw missingError;
                missing.push(component);
                continue;
            }
            throw error;
        }
    }
    return join(ancestor, ...missing);
}