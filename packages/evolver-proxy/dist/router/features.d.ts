import type { RouterFeatures } from './modelRouter.js';
declare const PLAN_RE: RegExp;
declare const SIMPLE_LOOKUP_MAX_CHARS = 80;
/** Loose by design — the handler passes an arbitrary request body; we validate `messages` is an array at use. */
interface MessagesBody {
    messages?: unknown;
}
export declare function extractFeatures(body: MessagesBody | null | undefined): RouterFeatures;
export { PLAN_RE, SIMPLE_LOOKUP_MAX_CHARS };