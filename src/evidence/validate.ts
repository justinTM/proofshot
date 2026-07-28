import { createHash } from 'node:crypto';
import {
  PROOF_BUNDLE_CONTRACT_VERSION,
  type AdapterIdentity,
  type Claim,
  type ClaimStatus,
  type CompiledProofBundle,
  type EvidenceReference,
  type ProofBundle,
  type Provenance,
  type ProofBundleValidation,
  type ValidationIssue,
  type ValidationOptions,
} from './contract.js';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ADAPTER_NAMESPACE = /^(?!proofshot(?:\.|$))[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_REVISION = /^[a-f0-9]{7,64}$/i;

function isValidDate(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

export function sha256Digest(content: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function duplicateIds<T extends { id: string }>(
  values: T[],
  path: string,
  errors: ValidationIssue[],
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (!value.id || seen.has(value.id)) {
      errors.push({
        code: value.id ? 'duplicate_identifier' : 'missing_identifier',
        path: `${path}[${index}].id`,
        message: value.id ? `Duplicate identifier: ${value.id}` : 'Identifier is required',
      });
    }
    seen.add(value.id);
  });
}

function validateAdapter(
  adapter: AdapterIdentity | undefined,
  path: string,
  errors: ValidationIssue[],
): void {
  if (!adapter) return;
  if (!ADAPTER_NAMESPACE.test(adapter.namespace)) {
    errors.push({
      code: 'invalid_adapter_namespace',
      path: `${path}.namespace`,
      message: 'Adapter namespace must be reverse-DNS-like and outside proofshot.*',
    });
  }
  if (!SEMVER.test(adapter.version)) {
    errors.push({
      code: 'invalid_adapter_version',
      path: `${path}.version`,
      message: 'Adapter version must be semantic version syntax',
    });
  }
}

function validateDigest(value: string | undefined, path: string, errors: ValidationIssue[]): void {
  if (value !== undefined && !SHA256.test(value)) {
    errors.push({ code: 'invalid_digest', path, message: 'Digest must use sha256:<64 lowercase hex>' });
  }
}

function validateProvenance(
  provenance: Provenance,
  path: string,
  errors: ValidationIssue[],
): void {
  if (!provenance?.producer) {
    errors.push({ code: 'missing_producer', path: `${path}.producer`, message: 'Producer identity is required' });
  }
  if (!isValidDate(provenance?.producedAt)) {
    errors.push({ code: 'invalid_timestamp', path: `${path}.producedAt`, message: 'A valid production timestamp is required' });
  }
  validateAdapter(provenance?.adapter, `${path}.adapter`, errors);

  const source = provenance?.source;
  if (source?.kind === 'git') {
    if (!source.repository) {
      errors.push({ code: 'missing_source_repository', path: `${path}.source.repository`, message: 'Git repository identity is required' });
    }
    if (!GIT_REVISION.test(source.head)) {
      errors.push({ code: 'invalid_source_head', path: `${path}.source.head`, message: 'Git HEAD must be an exact revision' });
    }
    if (source.worktree === 'dirty' && !source.diffDigest) {
      errors.push({ code: 'missing_dirty_digest', path: `${path}.source.diffDigest`, message: 'Dirty source requires a diff digest' });
    }
    if (source.relationToRecorded && source.relationToRecorded !== 'exact' && !source.upstreamHead) {
      errors.push({ code: 'missing_recorded_revision', path: `${path}.source.upstreamHead`, message: 'Source drift requires the compared revision' });
    }
    validateDigest(source.treeDigest, `${path}.source.treeDigest`, errors);
    validateDigest(source.diffDigest, `${path}.source.diffDigest`, errors);
  } else if (source?.kind === 'non_git') {
    if (!source.locator && !source.contentDigest) {
      errors.push({ code: 'missing_non_git_identity', path: `${path}.source`, message: 'Non-Git source requires a locator or content digest' });
    }
    validateDigest(source.contentDigest, `${path}.source.contentDigest`, errors);
  }

  validateDigest(provenance?.runtime?.configurationDigest, `${path}.runtime.configurationDigest`, errors);
  validateDigest(provenance?.runtime?.environmentDigest, `${path}.runtime.environmentDigest`, errors);
  if (provenance?.runtime && !provenance.runtime.name) {
    errors.push({ code: 'missing_runtime_identity', path: `${path}.runtime.name`, message: 'Runtime name is required' });
  }
  if (provenance?.target && !provenance.target.class) {
    errors.push({ code: 'missing_target_class', path: `${path}.target.class`, message: 'Target class is required' });
  }
}

function statusForClaim(
  claim: Claim,
  bundle: ProofBundle,
  invalidActuals: Set<string>,
): ClaimStatus {
  const actuals = claim.actualObservationIds
    .map((id) => bundle.actualObservations.find((actual) => actual.id === id))
    .filter((actual) => actual !== undefined);
  if (
    claim.expectedObservationIds.length === 0 ||
    actuals.length === 0 ||
    actuals.length !== claim.actualObservationIds.length ||
    claim.expectedObservationIds.some(
      (expectedId) => !actuals.some((actual) => actual.expectedObservationId === expectedId),
    )
  ) return 'not_observed';
  if (actuals.some((actual) => !claim.expectedObservationIds.includes(actual.expectedObservationId))) {
    return 'inconclusive';
  }
  if (actuals.some((actual) => invalidActuals.has(actual.id))) return 'inconclusive';
  if (actuals.some((actual) => actual.conclusion === 'contradicts')) return 'fail';
  if (actuals.some((actual) => actual.conclusion === 'blocked')) return 'blocked';
  if (actuals.some((actual) => actual.conclusion === 'ambiguous')) return 'inconclusive';
  if (actuals.some((actual) => actual.conclusion === 'not_observed')) return 'not_observed';
  return actuals.every((actual) => actual.conclusion === 'matches')
    ? 'pass'
    : 'inconclusive';
}

export function validateProofBundle(
  bundle: ProofBundle,
  options: ValidationOptions = {},
): ProofBundleValidation {
  const errors: ValidationIssue[] = [];
  const invalidActuals = new Set<string>();
  const now = options.now ?? new Date();

  if (bundle.contractVersion !== PROOF_BUNDLE_CONTRACT_VERSION) {
    errors.push({
      code: 'unsupported_contract_version',
      path: 'contractVersion',
      message: `Expected ${PROOF_BUNDLE_CONTRACT_VERSION}`,
    });
  }

  if (!isValidDate(bundle.createdAt)) {
    errors.push({ code: 'invalid_timestamp', path: 'createdAt', message: 'A valid bundle creation timestamp is required' });
  }

  duplicateIds(bundle.claims, 'claims', errors);
  duplicateIds(bundle.expectedObservations, 'expectedObservations', errors);
  duplicateIds(bundle.actualObservations, 'actualObservations', errors);
  duplicateIds(bundle.evidence, 'evidence', errors);
  duplicateIds(bundle.proofBoundaries, 'proofBoundaries', errors);
  duplicateIds(bundle.nonclaims, 'nonclaims', errors);

  validateProvenance(bundle.provenance, 'provenance', errors);
  bundle.expectedObservations.forEach((expected, index) => {
    const path = `expectedObservations[${index}]`;
    validateAdapter(expected.adapter, `${path}.adapter`, errors);
    validateAdapter(expected.expectation?.evaluator, `${path}.expectation.evaluator`, errors);
    if (
      !expected.description
      || !expected.expectation?.evaluator
      || expected.expectation.predicate === undefined
    ) {
      errors.push({ code: 'missing_expectation', path, message: 'A description and machine-readable predicate are required' });
    }
    if (!Array.isArray(expected.requiredEvidence) || expected.requiredEvidence.length === 0) {
      errors.push({ code: 'missing_required_evidence_kinds', path: `${path}.requiredEvidence`, message: 'At least one required evidence kind is required' });
    }
  });

  const expectedIds = new Set(bundle.expectedObservations.map(({ id }) => id));
  const actualIds = new Set(bundle.actualObservations.map(({ id }) => id));
  const evidenceById = new Map(bundle.evidence.map((item) => [item.id, item]));
  const boundaryById = new Map(bundle.proofBoundaries.map((item) => [item.id, item]));

  bundle.evidence.forEach((evidence, index) => {
    const path = `evidence[${index}]`;
    validateAdapter(evidence.adapter, `${path}.adapter`, errors);
    validateProvenance(evidence.provenance, `${path}.provenance`, errors);
    if (!SHA256.test(evidence.digest)) {
      errors.push({ code: 'invalid_digest', path: `${path}.digest`, message: 'A sha256 digest is required' });
    }
    if (!evidence.redaction?.policy) {
      errors.push({ code: 'missing_redaction_policy', path: `${path}.redaction`, message: 'Redaction policy must be recorded' });
    }
    if (evidence.sizeBytes !== undefined && (!Number.isSafeInteger(evidence.sizeBytes) || evidence.sizeBytes < 0)) {
      errors.push({ code: 'invalid_evidence_size', path: `${path}.sizeBytes`, message: 'Evidence size must be a non-negative integer' });
    }
    if (!isValidDate(evidence.access?.checkedAt)) {
      errors.push({ code: 'invalid_timestamp', path: `${path}.access.checkedAt`, message: 'Access check timestamp is required' });
    }
    if (!evidence.access?.accessible) {
      errors.push({ code: 'inaccessible_evidence', path: `${path}.access`, message: 'Evidence is not accessible' });
    }
    if (evidence.access?.expiresAt) {
      if (!isValidDate(evidence.access.expiresAt)) {
        errors.push({ code: 'invalid_timestamp', path: `${path}.access.expiresAt`, message: 'Expiry must be a valid timestamp' });
      } else if (new Date(evidence.access.expiresAt) <= now) {
        errors.push({ code: 'expired_evidence', path: `${path}.access.expiresAt`, message: 'Evidence has expired' });
      }
    }
    const content = options.resolveEvidence?.(evidence);
    if (content === undefined) {
      errors.push({ code: 'missing_evidence_content', path, message: 'Evidence content could not be resolved' });
    } else if (sha256Digest(content) !== evidence.digest) {
      errors.push({ code: 'digest_mismatch', path: `${path}.digest`, message: 'Evidence content does not match its digest' });
    }
  });

  bundle.actualObservations.forEach((actual, index) => {
    const path = `actualObservations[${index}]`;
    const mark = (code: string, childPath: string, message: string) => {
      invalidActuals.add(actual.id);
      errors.push({ code, path: `${path}.${childPath}`, message });
    };
    const provenanceErrorCount = errors.length;
    validateProvenance(actual.provenance, `${path}.provenance`, errors);
    if (errors.length > provenanceErrorCount) invalidActuals.add(actual.id);
    if (!isValidDate(actual.completedAt) || !actual.collectionOutcome || !actual.conclusion || !actual.description) {
      mark('missing_completed_outcome', 'collectionOutcome', 'A completed timestamp, collection outcome, conclusion, and description are required');
    }
    if (
      actual.collectionOutcome !== 'completed'
      && (actual.conclusion === 'matches' || actual.conclusion === 'contradicts')
    ) {
      mark('inconsistent_collection_outcome', 'collectionOutcome', 'Incomplete collection cannot match or contradict an expectation');
    }
    if (!expectedIds.has(actual.expectedObservationId)) {
      mark('dangling_expected_observation', 'expectedObservationId', 'Expected observation does not exist');
    }
    if (actual.provenanceDrift.detected) {
      mark('provenance_drift', 'provenanceDrift', 'Provenance drift prevents a clean pass');
      if (!actual.provenanceDrift.description) {
        mark('undeclared_provenance_drift', 'provenanceDrift', 'Detected provenance drift requires a description');
      }
    }
    if (!Array.isArray(actual.proofBoundaryIds) || actual.proofBoundaryIds.length === 0) {
      mark('missing_proof_boundary', 'proofBoundaryIds', 'Every completed observation requires a proof boundary');
    } else {
      actual.proofBoundaryIds.forEach((id, boundaryIndex) => {
        const boundary = boundaryById.get(id);
        if (!boundary) {
          mark('dangling_proof_boundary', `proofBoundaryIds[${boundaryIndex}]`, `Proof boundary does not exist: ${id}`);
        } else if (!boundary.exercised) {
          mark('unexercised_proof_boundary', `proofBoundaryIds[${boundaryIndex}]`, `Proof boundary was not exercised: ${id}`);
        } else if (!boundary.observationIds.includes(actual.id)) {
          mark('unlinked_proof_boundary', `proofBoundaryIds[${boundaryIndex}]`, `Proof boundary does not link back to observation: ${id}`);
        }
      });
    }
    const expected = bundle.expectedObservations.find(({ id }) => id === actual.expectedObservationId);
    const referenced = actual.evidenceIds.map((id) => evidenceById.get(id));
    actual.evidenceIds.forEach((id, evidenceIndex) => {
      if (!evidenceById.has(id)) mark('dangling_evidence', `evidenceIds[${evidenceIndex}]`, `Evidence does not exist: ${id}`);
    });
    expected?.requiredEvidence.forEach((kind) => {
      if (!referenced.some((evidence) => evidence?.kind === kind)) {
        mark('missing_required_evidence', 'evidenceIds', `Required ${kind} evidence is missing`);
      }
    });
    referenced.forEach((evidence) => {
      if (!evidence) return;
      const evidencePath = `evidence[${bundle.evidence.indexOf(evidence)}]`;
      if (errors.some((issue) => issue.path === evidencePath || issue.path.startsWith(`${evidencePath}.`))) {
        invalidActuals.add(actual.id);
      }
    });
  });

  bundle.claims.forEach((claim, index) => {
    claim.expectedObservationIds.forEach((id, childIndex) => {
      if (!expectedIds.has(id)) errors.push({ code: 'dangling_expected_observation', path: `claims[${index}].expectedObservationIds[${childIndex}]`, message: `Expected observation does not exist: ${id}` });
    });
    claim.actualObservationIds.forEach((id, childIndex) => {
      if (!actualIds.has(id)) errors.push({ code: 'dangling_actual_observation', path: `claims[${index}].actualObservationIds[${childIndex}]`, message: `Actual observation does not exist: ${id}` });
    });
  });

  bundle.proofBoundaries.forEach((boundary, index) => {
    if (boundary.doesNotProve.length === 0) {
      errors.push({ code: 'missing_boundary_nonclaim', path: `proofBoundaries[${index}].doesNotProve`, message: 'Proof boundary must state what it does not prove' });
    }
    boundary.observationIds.forEach((id, childIndex) => {
      if (!actualIds.has(id)) errors.push({ code: 'dangling_actual_observation', path: `proofBoundaries[${index}].observationIds[${childIndex}]`, message: `Actual observation does not exist: ${id}` });
    });
    boundary.evidenceIds.forEach((id, childIndex) => {
      if (!evidenceById.has(id)) errors.push({ code: 'dangling_evidence', path: `proofBoundaries[${index}].evidenceIds[${childIndex}]`, message: `Evidence does not exist: ${id}` });
    });
  });

  const claimIds = new Set(bundle.claims.map(({ id }) => id));
  bundle.nonclaims.forEach((nonclaim, index) => {
    nonclaim.claimIds?.forEach((id, childIndex) => {
      if (!claimIds.has(id)) errors.push({ code: 'dangling_claim', path: `nonclaims[${index}].claimIds[${childIndex}]`, message: `Claim does not exist: ${id}` });
    });
    nonclaim.proofBoundaryIds?.forEach((id, childIndex) => {
      if (!boundaryById.has(id)) errors.push({ code: 'dangling_proof_boundary', path: `nonclaims[${index}].proofBoundaryIds[${childIndex}]`, message: `Proof boundary does not exist: ${id}` });
    });
  });

  return {
    valid: errors.length === 0,
    errors,
    claimResults: bundle.claims.map((claim) => ({
      claimId: claim.id,
      status: statusForClaim(claim, bundle, invalidActuals),
    })),
  };
}

export function compileProofBundle(
  bundle: ProofBundle,
  options: ValidationOptions = {},
): CompiledProofBundle {
  const validation = validateProofBundle(bundle, options);
  return { bundle, ...validation };
}
