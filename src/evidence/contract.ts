export const PROOF_BUNDLE_CONTRACT_VERSION = '1.0.0' as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type Sha256Digest = `sha256:${string}`;

export type ClaimStatus =
  | 'pass'
  | 'fail'
  | 'blocked'
  | 'inconclusive'
  | 'not_observed';

export type ObservationConclusion =
  | 'matches'
  | 'contradicts'
  | 'blocked'
  | 'ambiguous'
  | 'not_observed';

export interface AdapterIdentity {
  /** Reverse-DNS namespace, kept outside the core namespace. */
  namespace: string;
  /** Semantic version of the adapter contract. */
  version: string;
}

export interface GitSourceIdentity {
  kind: 'git';
  repository: string;
  head: string;
  /** Null means detached HEAD. */
  ref: string | null;
  worktree: 'clean' | 'dirty';
  relationToRecorded?: 'exact' | 'advanced' | 'behind' | 'diverged' | 'unknown';
  upstreamHead?: string;
  treeDigest?: Sha256Digest;
  /** Required for a dirty worktree; records the diff without storing it. */
  diffDigest?: Sha256Digest;
}

export interface NonGitSourceIdentity {
  kind: 'non_git';
  locator?: string;
  contentDigest?: Sha256Digest;
}

export type SourceIdentity = GitSourceIdentity | NonGitSourceIdentity;

export interface RuntimeIdentity {
  name: string;
  version?: string;
  configurationDigest?: Sha256Digest;
  environmentDigest?: Sha256Digest;
}

export interface TargetIdentity {
  /** Adapter-defined class such as local, deployed, ci, file, or external. */
  class: string;
  locator?: string;
  deploymentId?: string;
  buildId?: string;
  sourceRevision?: string;
}

export interface Provenance {
  producer: string;
  producedAt: string;
  adapter?: AdapterIdentity;
  source?: SourceIdentity;
  runtime?: RuntimeIdentity;
  target?: TargetIdentity;
  environment?: Record<string, JsonValue>;
}

export interface ProvenanceDrift {
  detected: boolean;
  description?: string;
}

export interface ExpectedObservation {
  id: string;
  description: string;
  /** Adapter-owned, machine-readable predicate; core does not invent business semantics. */
  expectation: {
    evaluator: AdapterIdentity;
    predicate: JsonValue;
    tolerance?: JsonValue;
  };
  requiredEvidence: EvidenceKind[];
  adapter?: AdapterIdentity;
  metadata?: Record<string, JsonValue>;
}

export type CollectionOutcome = 'completed' | 'failed' | 'timed_out' | 'not_run';

export interface CompletedActualObservation {
  id: string;
  expectedObservationId: string;
  startedAt?: string;
  completedAt: string;
  collectionOutcome: CollectionOutcome;
  conclusion: ObservationConclusion;
  description: string;
  observedValue?: JsonValue;
  evidenceIds: string[];
  proofBoundaryIds: string[];
  provenance: Provenance;
  provenanceDrift: ProvenanceDrift;
  attemptedActions?: string[];
  metadata?: Record<string, JsonValue>;
}

export interface Claim {
  id: string;
  statement: string;
  expectedObservationIds: string[];
  actualObservationIds: string[];
  metadata?: Record<string, JsonValue>;
}

export type EvidenceKind =
  | 'terminal'
  | 'browser'
  | 'test'
  | 'generated_file'
  | 'url'
  | 'deployment';

export interface EvidenceReference {
  id: string;
  kind: EvidenceKind;
  uri: string;
  digest: Sha256Digest;
  sizeBytes?: number;
  mediaType?: string;
  provenance: Provenance;
  adapter?: AdapterIdentity;
  access: {
    accessible: boolean;
    checkedAt: string;
    scope?: string;
    expiresAt?: string;
    reason?: string;
  };
  retention: {
    policy: string;
    retainUntil?: string;
  };
  redaction: {
    policy: string;
    applied: boolean;
    description?: string;
  };
  metadata?: Record<string, JsonValue>;
}

export interface ProofBoundary {
  id: string;
  kind:
    | 'source_static'
    | 'local_runtime'
    | 'clean_checkout'
    | 'ci'
    | 'live_readonly'
    | 'live_write'
    | 'deployment'
    | 'readback'
    | 'human_acceptance'
    | 'unit_fixture';
  description: string;
  exercised: boolean;
  observationIds: string[];
  evidenceIds: string[];
  doesNotProve: string[];
}

export interface Nonclaim {
  id: string;
  statement: string;
  reason: string;
  claimIds?: string[];
  proofBoundaryIds?: string[];
}

export interface ProofBundle {
  contractVersion: typeof PROOF_BUNDLE_CONTRACT_VERSION;
  id: string;
  createdAt: string;
  provenance: Provenance;
  claims: Claim[];
  expectedObservations: ExpectedObservation[];
  actualObservations: CompletedActualObservation[];
  evidence: EvidenceReference[];
  proofBoundaries: ProofBoundary[];
  nonclaims: Nonclaim[];
}

export interface ClaimResult {
  claimId: string;
  status: ClaimStatus;
}

export interface ProofBundleValidation {
  valid: boolean;
  errors: ValidationIssue[];
  claimResults: ClaimResult[];
}

export interface CompiledProofBundle {
  bundle: ProofBundle;
  valid: boolean;
  errors: ValidationIssue[];
  claimResults: ClaimResult[];
}

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface ValidationOptions {
  now?: Date;
  /** Returns the exact referenced bytes. Missing bytes fail closed. */
  resolveEvidence?: (reference: EvidenceReference) => Uint8Array | string | undefined;
}
