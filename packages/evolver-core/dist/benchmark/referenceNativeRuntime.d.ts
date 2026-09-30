type SystemLibrary = 'kernel32.dll' | 'ntdll.dll' | null;
/**
 * Retain the JS LibraryHandle as well as its native function wrappers. Collecting
 * that wrapper invokes Koffi 3.2.1's finalizer during Bun 1.3.14 GC and can abort.
 * Only these three fixed system libraries live for the runtime's lifetime, even
 * after a partial binding failure. Callers still close every file/process HANDLE.
 */
export declare function loadReferenceSystemLibrary(name: SystemLibrary): ReturnType<typeof import('koffi').load>;
/** npm使用锁定依赖；单文件binary只能使用打包器已注入的同版本addon。 */
export declare function loadReferenceFfi(): typeof import('koffi');
export {};