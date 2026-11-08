/** Import roots, relative to the source checkout, that the venv's editable installs add to `sys.path`. */
export declare function editableImportRoots(venv: string, sourceRoot: string): string[];
/**
 * Editable installs record absolute paths into the checkout they were installed from, so a venv mirrored into a
 * verification copy would import the original sources. Returns the same locations inside the copy, which go on
 * PYTHONPATH ahead of site-packages.
 */
export declare function editableSourcesInCopy(venv: string, sourceRoot: string, copyRoot: string): string[];