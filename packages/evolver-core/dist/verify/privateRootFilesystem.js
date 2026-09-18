import { isAbsolute, relative, sep } from 'node:path';
// These paths belong to the trusted launcher, not the checkout. In particular a
// checkout must never replace setpriv or the shell before privileges are dropped.
const PRIVATE_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/dev', '/proc', '/tmp/node', '/tmp/home', '/tmp/.evolver-bin'];
function contains(root, target) {
    const rel = relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
export function privateRootPathsAllowed(root, cwd, scratch) {
    return [root, cwd, scratch].every(isAbsolute)
        && contains(root, cwd)
        && !contains(root, scratch)
        && !contains(scratch, root)
        && !PRIVATE_PATHS.some((path) => contains(root, path) || contains(path, root));
}
/** A non-recursive bind must not substitute the hidden underlying directory for a source submount. */
export function sourceHasNestedMounts(root, mountInfo) {
    return mountInfo.split('\n').some((line) => {
        const encoded = line.split(' ')[4];
        if (!encoded)
            return false;
        const target = encoded.replace(/\\(040|011|012|134)/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
        return relative(root, target) !== '' && contains(root, target);
    });
}
// The only process visible as PID 1 is already chrooted and unprivileged.
const PRIVATE_SUPERVISOR = [
    'validation_cwd="$1"; shift',
    'sandbox_bin="$1"; shift',
    'cd "$validation_cwd" || exit 126',
    'export HOME=/tmp/home TMPDIR=/tmp TMP=/tmp TEMP=/tmp',
    'exec "$sandbox_bin" "$@" </dev/null',
].join('; ');
// This fixed launcher stays OUTSIDE the workload PID namespace. A validator
// therefore cannot enumerate/kill its parent-death watcher. Only the trusted
// launcher uses -e; user-supplied evaluation flags remain rejected by the runner.
// ChildProcess keeps ownership of the live child handle, rather than persisting a
// shell PID that could be reused after wait. unshare --kill-child closes the cage.
export const PRIVATE_ROOT_GUARDIAN = [
    "const {spawn}=require('node:child_process')",
    'const [runtimeMode,bin,...args]=process.argv.slice(1)',
    'const env={...process.env}',
    "if(runtimeMode!=='bun')delete env.BUN_BE_BUN",
    "const child=spawn(bin,args,{shell:false,env,stdio:['ignore','inherit','inherit']})",
    'let cancelled=false',
    "const cancel=()=>{cancelled=true;child.kill('SIGKILL')}",
    "process.stdin.once('end',cancel)",
    "process.once('SIGTERM',cancel)",
    "process.once('SIGINT',cancel)",
    "child.once('error',()=>{process.stderr.write('[sandbox] namespace launcher failed\\n');process.exit(126)})",
    "child.once('close',code=>process.exit(cancelled?126:code??137))",
    'process.stdin.resume()',
].join('; ');
/** Fixed positional launcher: no source-derived value is interpolated as shell code. */
export function privateRootFilesystemSetup(scratchBytes, trustedPath) {
    return [
        `PATH=${trustedPath}; export PATH`,
        'session_tmp="$1"; shift',
        'validation_root="$1"; shift',
        'validation_cwd="$1"; shift',
        'host_bin="$1"; shift',
        'bin_name="${host_bin##*/}"',
        'sandbox_bin="/tmp/.evolver-bin/$bin_name"',
        'mount --make-rprivate / || exit 126',
        `mount -t tmpfs -o mode=755,size=${scratchBytes},nr_inodes=65536 none "$session_tmp" || exit 126`,
        'jail="$session_tmp/root"',
        'mkdir -p "$jail" || exit 126',
        // Do not bind /usr or /lib wholesale: their locked WSL/container submounts
        // are exactly why recursive inherited-root isolation can be unavailable.
        'for path in /usr/bin /bin /usr/sbin /sbin /usr/lib/*-linux-gnu /lib/*-linux-gnu /usr/lib64 /lib64 /usr/lib/cargo/bin/coreutils /usr/lib/python* /lib/python* /usr/libexec /usr/share/nodejs /usr/share/zoneinfo; do if [ -d "$path" ]; then mkdir -p "$jail$path" && mount --bind "$path" "$jail$path" && mount -o remount,bind,ro,nosuid,nodev "$jail$path" || exit 126; fi; done',
        // Flat musl/non-multiarch library layouts still need their loaders/libraries.
        'for path in /usr/lib/*.so* /lib/*.so*; do if [ -f "$path" ]; then mkdir -p "$jail$(dirname "$path")" && : > "$jail$path" && mount --bind "$path" "$jail$path" && mount -o remount,bind,ro,nosuid,nodev "$jail$path" || exit 126; fi; done',
        'mkdir -p "$jail/tmp" "$jail/proc" "$jail/dev" || exit 126',
        `mount -t tmpfs -o mode=1777,size=${scratchBytes},nr_inodes=65536 none "$jail/tmp" || exit 126`,
        'mkdir -p "$jail/tmp/home" "$jail/tmp/.evolver-bin" "$jail$validation_root" || exit 126',
        'mount --bind "$validation_root" "$jail$validation_root" && mount -o remount,bind,ro,nosuid,nodev "$jail$validation_root" || exit 126',
        '[ ! -L "$jail$validation_root/.git" ] || exit 126',
        'if [ -d "$jail$validation_root/.git" ]; then mount -t tmpfs -o ro,mode=755,size=65536,nr_inodes=64 none "$jail$validation_root/.git" || exit 126; elif [ -e "$jail$validation_root/.git" ]; then [ -f "$jail$validation_root/.git" ] || exit 126; : > "$session_tmp/empty-git"; mount --bind "$session_tmp/empty-git" "$jail$validation_root/.git" && mount -o remount,bind,ro "$jail$validation_root/.git" || exit 126; fi',
        // FIFOs, sockets and devices are host IPC channels even on a read-only bind.
        // find never opens their contents and runs within the runner deadline/PID tree.
        'special="$(find "$jail$validation_root" -xdev \\( -type p -o -type s -o -type b -o -type c \\) -print -quit)" || exit 126',
        '[ -z "$special" ] || { printf "%s\\n" "[sandbox] rejected: source contains special files"; exit 126; }',
        'mount -t proc -o nosuid,nodev,noexec none "$jail/proc" || exit 126',
        'for device in null zero random urandom; do : > "$jail/dev/$device" && mount --bind "/dev/$device" "$jail/dev/$device" || exit 126; done',
        'ln -s /proc/self/fd "$jail/dev/fd" || exit 126',
        ': > "$jail$sandbox_bin"',
        'mount --bind "$host_bin" "$jail$sandbox_bin" && mount -o remount,bind,ro "$jail$sandbox_bin" || exit 126',
        'mount -o remount,bind,ro "$session_tmp" || exit 126',
        'cd "$jail" || exit 126',
        // Pass the fixed supervisor as an argument, avoiding another shell expansion.
        `exec chroot "$jail" /usr/bin/setpriv --no-new-privs --securebits=+noroot,+noroot_locked --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- /bin/sh -c '${PRIVATE_SUPERVISOR.replaceAll("'", "'\\''")}' sh "$validation_cwd" "$sandbox_bin" "$@"`,
    ].join('; ');
}