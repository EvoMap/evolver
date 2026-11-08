import { type InjectionPlan, type RuntimeId } from './injection.js';
import type { InstallOptions, InstallResult, UninstallOptions } from './installerShared.js';
import { type InstallerTransaction } from './installerTransaction.js';
/** Only an adapter's successful owned-target check can attest this allowed transform; warnings are not proof. */
export declare function attestPreservedBridgeVerification<T extends InstallResult>(result: T, ownedVerified: boolean, bridgePreserved: boolean): T;
export declare function implicitInstallerPreflightActive(): boolean;
export declare function installerTransactionRoot(runtime: RuntimeId, options: Pick<UninstallOptions, 'scope' | 'homeDir' | 'configRoot'>): string;
export declare function installerArtifactTargets(preview: InstallResult): {
    id: string;
    paths: string[];
}[];
/** Reuse adapter preflight, merge and ownership checks; only the commit/compensation protocol is shared. */
export declare function runManagedInstallerTransaction(runtime: RuntimeId, options: InstallOptions | UninstallOptions, action: 'install' | 'uninstall', preview: (verification?: boolean) => InstallResult, apply: (targetPath?: string) => InstallResult, injectionPlan?: InjectionPlan): InstallResult;
export declare function completeManagedInstallerTransaction(transaction: InstallerTransaction, runtime: RuntimeId, action: 'install' | 'uninstall', mode: string, preview: (verification?: boolean) => InstallResult, apply: (targetPath?: string) => InstallResult): InstallResult;