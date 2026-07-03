import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey, createPrivateKey, randomBytes } from 'node:crypto';
import { CredentialStore } from './credentialStore.js';
/** 把 PEM 私钥还原成 KeyObject 用于签名. */
function privFromPem(pem) { return createPrivateKey(pem); }
/**
 * Ed25519 keypair 认证(M6-5, 进阶/审计级). 私钥只存本机 0600, authenticate 对 body 签名(审计可信源).
 * rotate=生成新对+注册+撤旧. 实现 core AuthProvider.
 */
export class KeypairProvider {
    opts;
    kind = 'keypair';
    store;
    constructor(opts) {
        this.opts = opts;
        this.store = new CredentialStore(opts.credPath);
    }
    async login() {
        const existing = this.store.load();
        if (existing && 'privateKey' in existing)
            return existing;
        return this.generate();
    }
    async generate() {
        const { publicKey, privateKey } = generateKeyPairSync('ed25519');
        const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
        const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
        const { credentialId } = await this.opts.registerPublicKey(pubPem);
        const cred = { id: credentialId, kind: 'keypair', publicKey: pubPem, privateKey: privPem };
        this.store.save(cred);
        return cred;
    }
    async authenticate(req) {
        const cred = this.store.load();
        if (!cred || !('privateKey' in cred))
            throw new Error('keypair 未初始化, 先 login()');
        const body = req.body ?? '';
        // Sign method+path+body+timestamp+nonce (#9): timestamp+nonce defeat REPLAY (a captured request can't be
        // re-sent — verify rejects a stale timestamp or a seen nonce), not just substitution. Both travel as headers
        // so the verifier can rebuild the exact signing string.
        const timestamp = String((this.opts.now ?? Date.now)());
        const nonce = (this.opts.nonceGen ?? (() => randomBytes(16).toString('hex')))();
        const signing = `${req.method}\n${req.path}\n${body}\n${timestamp}\n${nonce}`;
        const bodySignature = edSign(null, Buffer.from(signing), privFromPem(cred.privateKey)).toString('base64');
        return {
            headers: { 'x-evomap-key-id': cred.id, 'x-evomap-signature': bodySignature, 'x-evomap-timestamp': timestamp, 'x-evomap-nonce': nonce },
            bodySignature,
        };
    }
    async rotate() {
        const old = this.store.load();
        const fresh = await this.generate();
        if (old && this.opts.revokeRemote)
            await this.opts.revokeRemote(old.id).catch(() => { });
        return fresh;
    }
    async revoke(credentialId) {
        if (this.opts.revokeRemote)
            await this.opts.revokeRemote(credentialId);
    }
    /**
     * Verify a signed request (reference for the hub side). Checks all three: (1) Ed25519 signature over
     * method+path+body+timestamp+nonce, (2) freshness — timestamp within ±maxSkewMs of now, (3) replay —
     * the nonce has not been seen (when a seenNonces set is supplied; it is mutated to record this nonce).
     * Returns false on any failure (bad sig / stale / replayed). The hub keeps seenNonces with a short TTL.
     */
    static verify(publicKeyPem, req, signatureB64, proof, opts = {}) {
        const now = (opts.now ?? Date.now)();
        const maxSkew = opts.maxSkewMs ?? 300_000; // 5 min
        const ts = Number(proof.timestamp);
        if (!Number.isFinite(ts) || Math.abs(now - ts) > maxSkew)
            return false; // stale / future-dated → reject
        if (opts.seenNonces) {
            if (opts.seenNonces.has(proof.nonce))
                return false; // replay → reject
            opts.seenNonces.add(proof.nonce);
        }
        const signing = `${req.method}\n${req.path}\n${req.body ?? ''}\n${proof.timestamp}\n${proof.nonce}`;
        return edVerify(null, Buffer.from(signing), createPublicKey(publicKeyPem), Buffer.from(signatureB64, 'base64'));
    }
}