import type { JsonValue, ProvenanceDrift, Sha256Digest, SourceIdentity } from '../evidence/contract.js';

export type BrowserTargetClass = 'local' | 'deployed_readonly';
export type CaptureHealth = 'observed' | 'not_observed' | 'blocked';

export interface BrowserTargetProvenance {
  class: BrowserTargetClass;
  url: string;
  origin: string;
  deploymentId?: string;
  buildId?: string;
  sourceRevision?: string;
  /** Identifies rendered dirty source without persisting its contents. */
  sourceDiffDigest?: Sha256Digest;
}

export interface BrowserRuntimeProvenance {
  browser: { name: string; version?: string };
  driver: { name: string; version?: string };
  configurationVersion?: string;
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  renderSettings?: Record<string, JsonValue>;
}

export interface BrowserArtifactObservation {
  kind: 'screenshot' | 'video' | 'dom' | 'accessibility' | 'focus' | 'keyboard' | 'clipboard';
  health: CaptureHealth;
  uri?: string;
  value?: JsonValue;
  reason?: string;
  redacted?: boolean;
}

export interface BrowserEventObservation {
  kind: 'console' | 'network';
  health: CaptureHealth;
  level?: string;
  url?: string;
  method?: string;
  status?: number;
  message?: string;
  reason?: string;
}

export interface BrowserInteractionResult {
  action: string;
  status: 'completed' | 'failed' | 'timed_out' | 'blocked' | 'not_observed';
  startedAt?: string;
  completedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  timeout?: boolean;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
}

/** Driver-neutral browser evidence. Import adapters may populate only observed fields. */
export interface BrowserObservation {
  id: string;
  observedAt: string;
  target: BrowserTargetProvenance;
  proofBoundary: 'local_runtime' | 'live_readonly';
  source?: SourceIdentity;
  runtime: BrowserRuntimeProvenance;
  artifacts: BrowserArtifactObservation[];
  events: BrowserEventObservation[];
  interaction?: BrowserInteractionResult;
  captureHealth: {
    screenshot: CaptureHealth;
    video: CaptureHealth;
    dom: CaptureHealth;
    accessibility: CaptureHealth;
    focus: CaptureHealth;
    keyboard: CaptureHealth;
    clipboard: CaptureHealth;
    console: CaptureHealth;
    network: CaptureHealth;
  };
  provenanceDrift: ProvenanceDrift;
  metadata?: Record<string, JsonValue>;
}

export interface BrowserImportResult {
  adapter: { namespace: string; version: string };
  observations: BrowserObservation[];
  warnings: string[];
}

export interface BrowserImportContext {
  target: BrowserTargetProvenance;
  source?: SourceIdentity;
  runtime: BrowserRuntimeProvenance;
}

export function deriveCaptureHealth(
  collectionAttempted: boolean,
  collectionFailed: boolean,
): CaptureHealth {
  if (!collectionAttempted) return 'not_observed';
  return collectionFailed ? 'blocked' : 'observed';
}

export function detectBrowserProvenanceDrift(
  target: BrowserTargetProvenance,
  source?: SourceIdentity,
): ProvenanceDrift {
  if (!target.sourceRevision) {
    return { detected: true, description: 'Target source revision was not recorded' };
  }
  if (!source || source.kind !== 'git') {
    return { detected: true, description: 'Comparable Git source identity was not recorded' };
  }
  if (target.sourceRevision !== source.head) {
    return {
        detected: true,
        description: `Target source ${target.sourceRevision} does not match observed source ${source.head}`,
      };
  }
  if (source.worktree === 'dirty' && (!source.diffDigest || target.sourceDiffDigest !== source.diffDigest)) {
    return {
      detected: true,
      description: 'Dirty source diff identity does not match the rendered target',
    };
  }
  return { detected: false };
}

export function browserProofBoundary(target: BrowserTargetProvenance): BrowserObservation['proofBoundary'] {
  return target.class === 'local' ? 'local_runtime' : 'live_readonly';
}

export function validateBrowserImportContext(context: BrowserImportContext): void {
  let parsed: URL;
  try {
    parsed = new URL(context.target.url);
  } catch {
    throw new Error('Browser target URL must be absolute');
  }
  if (parsed.origin !== context.target.origin) {
    throw new Error('Browser target origin must match the target URL');
  }
  if (!context.target.sourceRevision) {
    throw new Error('Browser target sourceRevision is required');
  }
  if (!context.source) {
    throw new Error('Browser source identity is required');
  }
  if (context.target.class === 'deployed_readonly') {
    if (!context.target.deploymentId || !context.target.buildId) {
      throw new Error('Deployed browser targets require deploymentId and buildId');
    }
  }
  if (!context.runtime.browser.name || !context.runtime.driver.name) {
    throw new Error('Browser and driver runtime identities are required');
  }
}
