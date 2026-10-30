import { createHash } from 'node:crypto';
export function feedbackDestinationIdentity(mode, endpoint, principal, namespace = '') {
    if (!endpoint || !principal || [...endpoint, ...principal, ...namespace]
        .some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
        throw new Error('feedback destination identity unavailable');
    }
    return `sha256:${createHash('sha256').update(JSON.stringify([mode, endpoint, principal, namespace])).digest('hex')}`;
}