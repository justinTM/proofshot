import { describe, expect, it } from 'vitest';
import {
  PROOF_BUNDLE_CONTRACT_VERSION,
  type EvidenceKind,
  type EvidenceReference,
  type ProofBundle,
} from './contract.js';
import { compileProofBundle, sha256Digest, validateProofBundle } from './validate.js';

const contents: Record<string, string> = {};

function evidence(id: string, kind: EvidenceKind, content = `${kind}:${id}`): EvidenceReference {
  contents[id] = content;
  return {
    id,
    kind,
    uri: `memory://${id}`,
    digest: sha256Digest(content),
    provenance: {
      producer: 'example.collector',
      producedAt: '2026-07-27T10:00:00Z',
      adapter: { namespace: 'org.example.collector', version: '1.2.0' },
    },
    access: { accessible: true, checkedAt: '2026-07-27T10:01:00Z' },
    retention: { policy: 'retain-for-review', retainUntil: '2027-07-27T00:00:00Z' },
    redaction: { policy: 'secrets-v1', applied: false },
  };
}

function bundle(
  conclusion: ProofBundle['actualObservations'][number]['conclusion'] = 'matches',
  kinds: EvidenceKind[] = ['test'],
): ProofBundle {
  const refs = kinds.map((kind, index) => evidence(`ev-${index}`, kind));
  return {
    contractVersion: PROOF_BUNDLE_CONTRACT_VERSION,
    id: 'bundle-1',
    createdAt: '2026-07-27T10:02:00Z',
    provenance: { producer: 'fixture', producedAt: '2026-07-27T10:02:00Z' },
    claims: [{
      id: 'claim-1',
      statement: 'The observable outcome matches the expectation',
      expectedObservationIds: ['expected-1'],
      actualObservationIds: ['actual-1'],
    }],
    expectedObservations: [{
      id: 'expected-1',
      description: 'A modality-neutral expected observation',
      expectation: {
        evaluator: { namespace: 'org.example.assertion', version: '1.0.0' },
        predicate: { operator: 'equals', value: 'expected' },
      },
      requiredEvidence: kinds,
    }],
    actualObservations: [{
      id: 'actual-1',
      expectedObservationId: 'expected-1',
      completedAt: '2026-07-27T10:01:00Z',
      collectionOutcome: 'completed',
      conclusion,
      description: `Collection concluded: ${conclusion}`,
      evidenceIds: refs.map(({ id }) => id),
      proofBoundaryIds: ['unit-fixture'],
      provenance: { producer: 'fixture', producedAt: '2026-07-27T10:01:00Z' },
      provenanceDrift: { detected: false },
      attemptedActions: ['An action was attempted; this is not an outcome'],
    }],
    evidence: refs,
    proofBoundaries: [{
      id: 'unit-fixture',
      kind: 'unit_fixture',
      description: 'Fixture validation only',
      exercised: true,
      observationIds: ['actual-1'],
      evidenceIds: refs.map(({ id }) => id),
      doesNotProve: ['business correctness', 'live system behavior'],
    }],
    nonclaims: [{
      id: 'nonclaim-1',
      statement: 'This fixture proves a deployment succeeded',
      reason: 'No live deployment was exercised',
      claimIds: ['claim-1'],
      proofBoundaryIds: ['unit-fixture'],
    }],
  };
}

function validate(value: ProofBundle, overrides: Record<string, string> = {}) {
  return validateProofBundle(value, {
    now: new Date('2026-07-27T12:00:00Z'),
    resolveEvidence: ({ id }) => overrides[id] ?? contents[id],
  });
}

describe('proof bundle contract', () => {
  it.each([
    ['matches', 'pass'],
    ['contradicts', 'fail'],
    ['blocked', 'blocked'],
    ['ambiguous', 'inconclusive'],
    ['not_observed', 'not_observed'],
  ] as const)('derives %s as %s', (conclusion, status) => {
    const result = validate(bundle(conclusion));
    expect(result.valid).toBe(true);
    expect(result.claimResults).toEqual([{ claimId: 'claim-1', status }]);
  });

  it.each([
    'terminal',
    'browser',
    'test',
    'generated_file',
    'url',
    'deployment',
  ] as EvidenceKind[])('validates %s observations through the same primitives', (kind) => {
    expect(validate(bundle('matches', [kind])).claimResults[0].status).toBe('pass');
  });

  it('fails closed for missing completed outcomes; attempts alone never pass', () => {
    const value = bundle();
    value.actualObservations[0] = {
      ...value.actualObservations[0],
      completedAt: '',
      description: '',
      conclusion: undefined,
    } as unknown as ProofBundle['actualObservations'][number];
    const result = validate(value);
    expect(result.errors.map(({ code }) => code)).toContain('missing_completed_outcome');
    expect(result.claimResults[0].status).toBe('inconclusive');
  });

  it('rejects missing and tampered required evidence', () => {
    const missing = bundle();
    missing.actualObservations[0].evidenceIds = [];
    expect(validate(missing).errors.map(({ code }) => code)).toContain('missing_required_evidence');

    const tampered = bundle();
    const result = validate(tampered, { 'ev-0': 'tampered bytes' });
    expect(result.errors.map(({ code }) => code)).toContain('digest_mismatch');
    expect(result.claimResults[0].status).toBe('inconclusive');
  });

  it('rejects inaccessible, expired, and unresolved evidence', () => {
    const value = bundle();
    value.evidence[0].access.accessible = false;
    value.evidence[0].access.expiresAt = '2026-07-27T11:00:00Z';
    delete contents['ev-0'];
    const codes = validate(value).errors.map(({ code }) => code);
    expect(codes).toEqual(expect.arrayContaining([
      'inaccessible_evidence',
      'expired_evidence',
      'missing_evidence_content',
    ]));
  });

  it('requires a provenance drift declaration', () => {
    const value = bundle();
    value.actualObservations[0].provenanceDrift = { detected: true };
    const result = validate(value);
    expect(result.errors.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'provenance_drift',
      'undeclared_provenance_drift',
    ]));
    expect(result.claimResults[0].status).toBe('inconclusive');

    value.actualObservations[0].provenanceDrift.description = 'Recorded source advanced';
    const declared = validate(value);
    expect(declared.errors.map(({ code }) => code)).toContain('provenance_drift');
    expect(declared.claimResults[0].status).toBe('inconclusive');
  });

  it('requires completed collection before a match can pass', () => {
    const value = bundle();
    value.actualObservations[0].collectionOutcome = 'timed_out';
    const result = validate(value);
    expect(result.errors.map(({ code }) => code)).toContain('inconsistent_collection_outcome');
    expect(result.claimResults[0].status).toBe('inconclusive');
  });

  it('binds completed observations to exercised proof boundaries', () => {
    const missing = bundle();
    missing.actualObservations[0].proofBoundaryIds = [];
    expect(validate(missing).errors.map(({ code }) => code)).toContain('missing_proof_boundary');

    const unlinked = bundle();
    unlinked.proofBoundaries[0].observationIds = [];
    expect(validate(unlinked).errors.map(({ code }) => code)).toContain('unlinked_proof_boundary');
  });

  it('distinguishes dirty, detached, advanced, and non-Git source identity', () => {
    const dirty = bundle();
    dirty.provenance.source = {
      kind: 'git',
      repository: 'https://example.test/repo.git',
      head: '0123456789abcdef0123456789abcdef01234567',
      ref: null,
      worktree: 'dirty',
      relationToRecorded: 'advanced',
    };
    const dirtyCodes = validate(dirty).errors.map(({ code }) => code);
    expect(dirtyCodes).toEqual(expect.arrayContaining([
      'missing_dirty_digest',
      'missing_recorded_revision',
    ]));

    const nonGit = bundle();
    nonGit.provenance.source = { kind: 'non_git' };
    expect(validate(nonGit).errors.map(({ code }) => code)).toContain('missing_non_git_identity');
  });

  it('compiles deterministic claim results with the validated bundle', () => {
    const value = bundle();
    const compiled = compileProofBundle(value, {
      now: new Date('2026-07-27T12:00:00Z'),
      resolveEvidence: ({ id }) => contents[id],
    });
    expect(compiled.bundle).toBe(value);
    expect(compiled.valid).toBe(true);
    expect(compiled.claimResults).toEqual([{ claimId: 'claim-1', status: 'pass' }]);
  });

  it('records redaction and explicit nonclaims', () => {
    const value = bundle();
    value.evidence[0].redaction = { policy: 'pii-v2', applied: true, description: 'Email removed' };
    expect(validate(value).valid).toBe(true);
    expect(value.nonclaims[0].statement).toContain('deployment');

    value.evidence[0].redaction.policy = '';
    expect(validate(value).errors.map(({ code }) => code)).toContain('missing_redaction_policy');
  });

  it('rejects dangling and duplicate identifiers and invalid adapter boundaries', () => {
    const value = bundle();
    value.claims.push({ ...value.claims[0] });
    value.claims[0].actualObservationIds.push('missing');
    value.evidence[0].adapter = { namespace: 'proofshot.browser', version: 'latest' };
    const codes = validate(value).errors.map(({ code }) => code);
    expect(codes).toEqual(expect.arrayContaining([
      'duplicate_identifier',
      'dangling_actual_observation',
      'invalid_adapter_namespace',
      'invalid_adapter_version',
    ]));
    expect(validate(value).claimResults[0].status).not.toBe('pass');
  });
});
