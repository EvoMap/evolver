import { randomInt } from 'node:crypto';
import { closeSync, fstatSync, lstatSync } from 'node:fs';
import { loadReferenceFfi, loadReferenceSystemLibrary } from '../benchmark/referenceNativeRuntime.js';
const FILTER_VNODE = -4, FILTER_USER = -10;
const ADD_CLEAR = 0x1 | 0x4 | 0x20, EVENT_ERROR = 0x4000, RECEIPT = 0x40;
// Bound inode/permission/link-count changes invalidate the witness; ordinary file contents do not.
const CHANGED = 0x1 | 0x8 | 0x10 | 0x20 | 0x40;
const TRIGGER = 0x01000000;
let native;
function api() {
    if (native)
        return native;
    const ffi = loadReferenceFfi();
    const library = loadReferenceSystemLibrary('/usr/lib/libSystem.B.dylib');
    const event = ffi.struct({ ident: 'uintptr_t', filter: 'int16_t', flags: 'uint16_t',
        fflags: 'uint32_t', data: 'intptr_t', udata: 'void *' });
    const time = ffi.struct({ tv_sec: 'int64_t', tv_nsec: 'int64_t' });
    if (ffi.sizeof(event) !== 32 || ffi.sizeof('uintptr_t') !== 8)
        throw new DarwinVnodeWitnessError('unavailable');
    native = {
        queue: library.func('int kqueue(void)'),
        open: library.func('int open(const char *, int)'),
        event: library.func('kevent', 'int', ['int', ffi.pointer(event), 'int',
            ffi.out(ffi.pointer(event)), 'int', ffi.pointer(time)]),
    };
    return native;
}
export class DarwinVnodeWitnessError extends Error {
    code;
    constructor(code, options) {
        super(`darwin_vnode_${code}`, options);
        this.code = code;
    }
}
const descriptorIdentity = (fd) => {
    const value = fstatSync(fd, { bigint: true });
    return `${value.dev}:${value.ino}:${value.mode & 61440n}:${value.birthtimeNs}`;
};
const entry = (ident, filter, flags, fflags) => ({ ident, filter, flags, fflags, data: 0, udata: null });
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameAttributes = (a, b) => a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs
    && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink;
const unconfirmed = () => new DarwinVnodeWitnessError('unconfirmed');
function verifyDescriptor(fd, identity) {
    if (descriptorIdentity(fd) !== identity)
        throw unconfirmed();
}
function attempt(errors, run) {
    try {
        run();
    }
    catch (error) {
        errors.push(error);
    }
}
function fenceRegisteredName(fd, path, observed) {
    const current = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (!sameInode(current, observed) || !sameInode(named, observed))
        throw unconfirmed();
    if (!sameAttributes(current, observed) || !sameAttributes(named, observed))
        throw new DarwinVnodeWitnessError('changed');
}
class KernelWitness {
    functions;
    descriptors = new Map();
    marker = randomInt(1, 0x7fffffff);
    queue = -1;
    registered = false;
    exposed = false;
    settled = false;
    closeFailure;
    invalid;
    pending;
    constructor(functions) {
        this.functions = functions;
    }
    static acquire(bindings) {
        let witness;
        try {
            witness = new KernelWitness(api());
            witness.register(bindings);
            witness.exposed = true;
            witness.assertUnchanged();
            return witness;
        }
        catch (failure) {
            try {
                witness?.close();
            }
            catch (cleanup) {
                const cause = new AggregateError([failure, cleanup]);
                // Two confirmed name changes are not a failed descriptor cleanup.
                if (failure instanceof DarwinVnodeWitnessError && failure.code === 'changed'
                    && cleanup instanceof DarwinVnodeWitnessError && cleanup.code === 'changed') {
                    throw new DarwinVnodeWitnessError('changed', { cause });
                }
                throw new DarwinVnodeWitnessError('cleanup_failed', { cause });
            }
            if (failure instanceof DarwinVnodeWitnessError)
                throw failure;
            throw new DarwinVnodeWitnessError('unavailable', { cause: failure });
        }
    }
    assertUnchanged() {
        if (this.settled)
            throw unconfirmed();
        if (this.invalid)
            throw this.invalid;
        try {
            if (this.observe())
                throw new DarwinVnodeWitnessError('changed');
        }
        catch (cause) {
            // EV_CLEAR drains the notification, never the lifetime failure of this binding.
            this.invalid = cause instanceof DarwinVnodeWitnessError ? cause : new DarwinVnodeWitnessError('unconfirmed', { cause });
            throw this.invalid;
        }
    }
    close() {
        if (this.settled) {
            if (this.closeFailure)
                throw this.closeFailure;
            return;
        }
        this.settled = true;
        const errors = [];
        const ownsQueue = this.drainAtClose(errors);
        // A pending descriptor was just acquired synchronously; no caller callback has run.
        if (this.pending !== undefined) {
            const fd = this.pending;
            attempt(errors, () => closeSync(fd));
        }
        for (const [fd, identity] of this.descriptors)
            attempt(errors, () => {
                verifyDescriptor(fd, identity);
                if (this.exposed) {
                    if (!ownsQueue)
                        return; // The recorded queue failure retains every unproven file slot.
                    this.verifyRegistration(fd);
                }
                closeSync(fd);
            });
        if (this.queue >= 0 && ownsQueue)
            attempt(errors, () => closeSync(this.queue));
        if (!errors.length)
            return;
        this.closeFailure = errors.length === 1 && errors[0] instanceof DarwinVnodeWitnessError
            ? errors[0] : new DarwinVnodeWitnessError('cleanup_failed', { cause: new AggregateError(errors) });
        throw this.closeFailure;
    }
    register(bindings) {
        this.queue = this.functions.queue();
        if (this.queue < 0)
            throw new DarwinVnodeWitnessError('unavailable');
        if (this.functions.event(this.queue, [entry(this.marker, FILTER_USER, ADD_CLEAR, 0)], 1, null, 0, null) !== 0) {
            throw new DarwinVnodeWitnessError('unavailable');
        }
        this.registered = true;
        for (const binding of bindings)
            this.bind(binding);
    }
    bind(binding) {
        // O_EVTONLY | O_SYMLINK opens an actual symlink inode instead of following it.
        const fd = this.functions.open(binding.path, 0x8000 | 0x200000);
        if (fd < 0)
            throw new DarwinVnodeWitnessError('unavailable');
        this.pending = fd;
        const observed = fstatSync(fd, { bigint: true });
        this.descriptors.set(fd, descriptorIdentity(fd));
        this.pending = undefined;
        if (observed.dev !== binding.dev || observed.ino !== binding.ino
            || (!observed.isDirectory() && !observed.isSymbolicLink()))
            throw unconfirmed();
        if (this.functions.event(this.queue, [entry(fd, FILTER_VNODE, ADD_CLEAR, CHANGED)], 1, null, 0, null) !== 0) {
            throw new DarwinVnodeWitnessError('unavailable');
        }
        // Register before handing off; then fence both the opened inode and its current name.
        fenceRegisteredName(fd, binding.path, observed);
    }
    drainAtClose(errors) {
        if (!this.registered)
            return true;
        try {
            if (this.observe(false))
                errors.push(new DarwinVnodeWitnessError('changed'));
            return true;
        }
        catch (error) {
            errors.push(error);
            return false;
        }
    }
    observe(verifyFiles = true) {
        try {
            if (verifyFiles)
                for (const [fd, identity] of this.descriptors)
                    verifyDescriptor(fd, identity);
            const events = Array.from({ length: this.descriptors.size + 1 }, () => ({}));
            // An existing private EVFILT_USER registration proves this is still our queue.
            // flags=0 must never create a replacement registration on a foreign descriptor.
            const count = this.functions.event(this.queue, [entry(this.marker, FILTER_USER, 0, TRIGGER)], 1, events, events.length, { tv_sec: 0, tv_nsec: 0 });
            if (count < 1 || count > events.length)
                throw unconfirmed();
            const changed = this.classify(events.slice(0, count));
            // The private ACK must prove queue ownership before touching vnode registrations.
            if (verifyFiles)
                for (const fd of this.descriptors.keys())
                    this.verifyRegistration(fd);
            return changed;
        }
        catch (cause) {
            if (cause instanceof DarwinVnodeWitnessError)
                throw cause;
            throw new DarwinVnodeWitnessError('unconfirmed', { cause });
        }
    }
    verifyRegistration(fd) {
        const receipts = [{}];
        // No EV_ADD: a closed/reused slot must not gain a replacement watcher.
        const count = this.functions.event(this.queue, [entry(fd, FILTER_VNODE, RECEIPT, CHANGED)], 1, receipts, 1, { tv_sec: 0, tv_nsec: 0 });
        const receipt = receipts[0];
        if (count !== 1 || receipt.ident !== fd || receipt.filter !== FILTER_VNODE
            || !Number.isInteger(receipt.flags) || !(receipt.flags & EVENT_ERROR) || receipt.data !== 0)
            throw unconfirmed();
    }
    classify(events) {
        let acknowledged = false, changed = false;
        for (const value of events) {
            if (!Number.isInteger(value.flags) || (value.flags & EVENT_ERROR))
                throw unconfirmed();
            if (value.filter === FILTER_USER && value.ident === this.marker && !acknowledged)
                acknowledged = true;
            else {
                this.assertBoundChange(value);
                changed = true;
            }
        }
        if (!acknowledged)
            throw unconfirmed();
        return changed;
    }
    assertBoundChange(value) {
        if (value.filter !== FILTER_VNODE || !this.descriptors.has(value.ident) || !Number.isInteger(value.fflags)
            || !(value.fflags & CHANGED))
            throw unconfirmed();
    }
}
/** Zero-time kernel observations of the actual bound inodes; no FSEvents latency or timestamp inference. */
export function createDarwinVnodeWitness(bindings) {
    if (process.platform !== 'darwin' || !bindings.length || bindings.length > 64)
        throw new DarwinVnodeWitnessError('unavailable');
    return KernelWitness.acquire(bindings);
}