import type { CaptureHealth } from '../browser/evidence.js';
import type {
  ClaimStatus,
  ClaimResult,
  ProofBundle,
  ProofBundleValidation,
  ValidationIssue,
} from '../evidence/contract.js';

export interface ReviewBundlePolicy {
  budgets: {
    perItemBytes: number;
    totalBytes: number;
  };
  retention: {
    policy: string;
    retainUntil?: string;
  };
  access: {
    scope: string;
    expiresAt?: string;
  };
  privacy: {
    policy: string;
    rawTerminalVideo: 'excluded' | 'opt_in';
    rawBrowserVideo: 'excluded' | 'opt_in';
  };
}

export interface ReviewCaptureHealth {
  terminal?: CaptureHealth;
  browser?: CaptureHealth;
  video?: CaptureHealth;
  [name: string]: CaptureHealth | undefined;
}

export interface CompileReviewBundleOptions {
  bundle: ProofBundle;
  outputDirectory: string;
  /** Exact bytes keyed by EvidenceReference.uri. Unresolvable evidence fails closed. */
  evidence: ReadonlyMap<string, Uint8Array | string> | Record<string, Uint8Array | string>;
  policy: ReviewBundlePolicy;
  captureHealth?: ReviewCaptureHealth;
  /** Duration of retained media after trimming; never wall-clock session duration. */
  postTrimMediaDurationSeconds?: number;
  includeViewer?: boolean;
  now?: Date;
}

export interface ReviewObject {
  digest: string;
  locator: string;
  sizeBytes: number;
  evidenceIds: string[];
  mediaTypes: string[];
  materialized: boolean;
  reason?: string;
}

export interface ReviewManifest {
  format: 'proofshot-review-bundle';
  version: '1.0.0';
  bundleId: string;
  createdAt: string;
  semanticStatus: {
    /** Contract/byte validation, distinct from whether claims passed. */
    valid: boolean;
    /** Conservative rollup of claim results, never inferred from presentation. */
    result: ClaimStatus;
    claims: Array<ClaimResult & { statement: string }>;
    issues: ValidationIssue[];
  };
  expectedObservations: ProofBundle['expectedObservations'];
  actualObservations: ProofBundle['actualObservations'];
  proofBoundaries: ProofBundle['proofBoundaries'];
  provenance: ProofBundle['provenance'];
  captureHealth: ReviewCaptureHealth;
  nonclaims: ProofBundle['nonclaims'];
  evidence: ProofBundle['evidence'];
  objects: ReviewObject[];
  policy: ReviewBundlePolicy & {
    deduplication: 'sha256-content-addressed';
  };
  contentSize: {
    declaredBytes: number;
    referencedBytes: number;
    storedBytes: number;
    verifiedObjectBytes: number;
    itemCount: number;
    uniqueObjectCount: number;
  };
  media: {
    postTrimDurationSeconds: number | null;
    playbackOptional: true;
  };
  viewer: 'viewer.html' | null;
}

export interface CompiledReviewBundle {
  manifest: ReviewManifest;
  validation: ProofBundleValidation;
  paths: {
    manifest: string;
    summary: string;
    viewer?: string;
  };
}
