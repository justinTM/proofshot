import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  ClaimResult,
  ClaimStatus,
  EvidenceReference,
  ProofBundleValidation,
  ValidationIssue,
} from '../evidence/contract.js';
import { sha256Digest, validateProofBundle } from '../evidence/validate.js';
import type {
  CompileReviewBundleOptions,
  CompiledReviewBundle,
  ReviewManifest,
  ReviewObject,
} from './types.js';

const encoder = new TextEncoder();

function bytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? encoder.encode(value) : value;
}

function resolveContent(
  evidence: CompileReviewBundleOptions['evidence'],
  reference: EvidenceReference,
): Uint8Array | string | undefined {
  return evidence instanceof Map
    ? evidence.get(reference.uri)
    : (evidence as Record<string, Uint8Array | string>)[reference.uri];
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusLabel(status: ClaimStatus): string {
  return status.replace(/_/g, ' ').toUpperCase();
}

function claimRollup(results: ClaimResult[]): ClaimStatus {
  const priority: ClaimStatus[] = ['fail', 'blocked', 'inconclusive', 'not_observed', 'pass'];
  return priority.find((status) => results.some((result) => result.status === status)) ?? 'not_observed';
}

function markdownInline(value: unknown): string {
  return String(value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/([\\`*_[\]<>])/g, '\\$1');
}

function indentedJson(value: unknown): string[] {
  return JSON.stringify(value, null, 2).split('\n').map((line) => `    ${line}`);
}

function policyIssues(options: CompileReviewBundleOptions): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { policy } = options;
  if (!Number.isSafeInteger(policy.budgets.perItemBytes) || policy.budgets.perItemBytes <= 0) {
    issues.push({ code: 'invalid_item_budget', path: 'policy.budgets.perItemBytes', message: 'A positive per-item content budget is required' });
  }
  if (!Number.isSafeInteger(policy.budgets.totalBytes) || policy.budgets.totalBytes <= 0) {
    issues.push({ code: 'invalid_total_budget', path: 'policy.budgets.totalBytes', message: 'A positive total content budget is required' });
  }
  if (!policy.retention.policy) {
    issues.push({ code: 'missing_retention_policy', path: 'policy.retention.policy', message: 'A retention policy is required' });
  }
  if (policy.retention.retainUntil) {
    const retainUntil = Date.parse(policy.retention.retainUntil);
    if (Number.isNaN(retainUntil)) {
      issues.push({ code: 'invalid_retention_expiry', path: 'policy.retention.retainUntil', message: 'Retention expiry must be a valid timestamp' });
    } else if (retainUntil <= (options.now ?? new Date()).getTime()) {
      issues.push({ code: 'expired_bundle_retention', path: 'policy.retention.retainUntil', message: 'Bundle retention has expired' });
    }
  }
  if (!policy.access.scope) {
    issues.push({ code: 'missing_access_scope', path: 'policy.access.scope', message: 'An access scope is required' });
  }
  if (policy.access.expiresAt) {
    const expires = Date.parse(policy.access.expiresAt);
    if (Number.isNaN(expires)) {
      issues.push({ code: 'invalid_access_expiry', path: 'policy.access.expiresAt', message: 'Access expiry must be a valid timestamp' });
    } else if (expires <= (options.now ?? new Date()).getTime()) {
      issues.push({ code: 'expired_bundle_access', path: 'policy.access.expiresAt', message: 'Bundle access has expired' });
    }
  }
  if (!policy.privacy.policy) {
    issues.push({ code: 'missing_privacy_policy', path: 'policy.privacy.policy', message: 'An explicit privacy policy is required' });
  }
  if (!['excluded', 'opt_in'].includes(policy.privacy.rawTerminalVideo)
    || !['excluded', 'opt_in'].includes(policy.privacy.rawBrowserVideo)) {
    issues.push({ code: 'invalid_video_privacy_mode', path: 'policy.privacy', message: 'Raw video policy must be excluded or opt_in' });
  }
  if (options.postTrimMediaDurationSeconds !== undefined
    && (!Number.isFinite(options.postTrimMediaDurationSeconds) || options.postTrimMediaDurationSeconds < 0)) {
    issues.push({ code: 'invalid_media_duration', path: 'postTrimMediaDurationSeconds', message: 'Post-trim media duration must be a non-negative finite number' });
  }
  return issues;
}

function renderSummary(manifest: ReviewManifest): string {
  const lines = [
    '# ProofShot Claim Review',
    '',
    `Bundle contract: **${manifest.semanticStatus.valid ? 'VALID' : 'INVALID — FAIL CLOSED'}**`,
    `Claim rollup: **${statusLabel(manifest.semanticStatus.result)}**`,
    ...(manifest.viewer ? ['', '[Open the portable viewer](./viewer.html)'] : []),
    '',
    '## Claims',
    '',
  ];
  for (const result of manifest.semanticStatus.claims) {
    lines.push(`- **${statusLabel(result.status)}** — ${markdownInline(result.statement)} (\`${markdownInline(result.claimId)}\`)`);
  }
  lines.push('', '## Expected and actual observations', '');
  for (const expected of manifest.expectedObservations) {
    const actuals = manifest.actualObservations.filter((item) => item.expectedObservationId === expected.id);
    lines.push(`### ${markdownInline(expected.id)}`, '', `Expected: ${markdownInline(expected.description)}`, '');
    if (actuals.length === 0) lines.push('Actual: not observed', '');
    for (const actual of actuals) {
      lines.push(
        `Actual (${markdownInline(actual.conclusion)}; collection ${markdownInline(actual.collectionOutcome)}): ${markdownInline(actual.description)}`,
        '',
      );
    }
  }
  lines.push('## Proof boundaries', '');
  for (const boundary of manifest.proofBoundaries) {
    lines.push(
      `- **${markdownInline(boundary.id)}** (${boundary.exercised ? 'exercised' : 'not exercised'}): ${markdownInline(boundary.description)}`,
      `  - Does not prove: ${boundary.doesNotProve.map(markdownInline).join('; ')}`,
    );
  }
  lines.push(
    '',
    '## Provenance and capture health',
    '',
    ...indentedJson({ provenance: manifest.provenance, captureHealth: manifest.captureHealth }),
    '',
    '## Nonclaims',
    '',
  );
  for (const item of manifest.nonclaims) {
    lines.push(`- **${markdownInline(item.statement)}** — ${markdownInline(item.reason)}`);
  }
  lines.push('', '## Evidence references', '');
  for (const evidence of manifest.evidence) {
    const object = manifest.objects.find(({ digest }) => digest === evidence.digest);
    lines.push(
      `- **${markdownInline(evidence.id)}** (${markdownInline(evidence.kind)}; ${markdownInline(evidence.mediaType ?? 'media type not recorded')})`,
      `  - Digest: \`${markdownInline(evidence.digest)}\``,
      `  - Access: ${evidence.access.accessible ? 'accessible' : 'inaccessible'}; scope ${markdownInline(evidence.access.scope ?? 'not recorded')}${evidence.access.expiresAt ? `; expires ${markdownInline(evidence.access.expiresAt)}` : ''}`,
      `  - Retention: ${markdownInline(evidence.retention.policy)}${evidence.retention.retainUntil ? ` through ${markdownInline(evidence.retention.retainUntil)}` : ''}`,
      object?.materialized
        ? `  - Object: [open content-addressed bytes](./${object.locator}) — presentation/context only, not an assertion.`
        : `  - Object: not materialized${object?.reason ? ` (${markdownInline(object.reason)})` : ''}.`,
    );
  }
  lines.push(
    '',
    '## Portability and retention',
    '',
    `- Post-trim media duration: ${manifest.media.postTrimDurationSeconds === null ? 'not recorded' : `${manifest.media.postTrimDurationSeconds} seconds`}`,
    '- WebM playback: optional; semantic review does not depend on a codec or browser extension.',
    `- Content budgets: ${manifest.policy.budgets.perItemBytes} bytes per item; ${manifest.policy.budgets.totalBytes} bytes total.`,
    `- Deduplication: ${manifest.policy.deduplication}.`,
    `- Retention: ${markdownInline(manifest.policy.retention.policy)}${manifest.policy.retention.retainUntil ? ` through ${markdownInline(manifest.policy.retention.retainUntil)}` : ''}.`,
    `- Access scope: ${markdownInline(manifest.policy.access.scope)}${manifest.policy.access.expiresAt ? `; expires ${markdownInline(manifest.policy.access.expiresAt)}` : ''}.`,
    `- Privacy: ${markdownInline(manifest.policy.privacy.policy)}; terminal video ${manifest.policy.privacy.rawTerminalVideo}; browser video ${manifest.policy.privacy.rawBrowserVideo}.`,
    '',
    '## Validation issues',
    '',
  );
  if (manifest.semanticStatus.issues.length === 0) lines.push('- None.');
  for (const issue of manifest.semanticStatus.issues) {
    lines.push(`- **${markdownInline(issue.code)}** at \`${markdownInline(issue.path)}\`: ${markdownInline(issue.message)}`);
  }
  lines.push('', 'Raw machine data: [manifest.json](./manifest.json)', '');
  return `${lines.join('\n')}\n`;
}

function renderViewer(manifest: ReviewManifest): string {
  const claims = manifest.semanticStatus.claims.map((result) => {
    return `<article class="claim ${escapeHtml(result.status)}"><h3><span class="status">${escapeHtml(statusLabel(result.status))}</span> ${escapeHtml(result.statement)}</h3><p><code>${escapeHtml(result.claimId)}</code></p></article>`;
  }).join('');
  const observations = manifest.expectedObservations.map((expected) => {
    const actuals = manifest.actualObservations.filter((item) => item.expectedObservationId === expected.id);
    return `<article><h3>${escapeHtml(expected.id)}</h3><p><strong>Expected:</strong> ${escapeHtml(expected.description)}</p>${
      actuals.length
        ? actuals.map((actual) => `<p><strong>Actual (${escapeHtml(actual.conclusion)}; ${escapeHtml(actual.collectionOutcome)}):</strong> ${escapeHtml(actual.description)}</p><details><summary>Raw observation JSON</summary><pre>${escapeHtml(JSON.stringify(actual, null, 2))}</pre></details>`).join('')
        : '<p><strong>Actual:</strong> not observed</p>'
    }</article>`;
  }).join('');
  const boundaries = manifest.proofBoundaries.map((boundary) =>
    `<li><strong>${escapeHtml(boundary.id)}</strong> — ${escapeHtml(boundary.description)}<br><span>Does not prove: ${escapeHtml(boundary.doesNotProve.join('; '))}</span></li>`).join('');
  const nonclaims = manifest.nonclaims.map((item) =>
    `<li><strong>${escapeHtml(item.statement)}</strong> — ${escapeHtml(item.reason)}</li>`).join('');
  const issues = manifest.semanticStatus.issues.length
    ? manifest.semanticStatus.issues.map((issue) => `<li><strong>${escapeHtml(issue.code)}</strong> at <code>${escapeHtml(issue.path)}</code>: ${escapeHtml(issue.message)}</li>`).join('')
    : '<li>None.</li>';
  const evidence = manifest.evidence.map((reference) => {
    const object = manifest.objects.find(({ digest }) => digest === reference.digest);
    const objectLink = object?.materialized
      ? `<p><a href="${escapeHtml(object.locator)}">Open content-addressed bytes</a> <span class="context">— presentation/context only, not an assertion</span></p>`
      : `<p><strong>Object not materialized.</strong>${object?.reason ? ` ${escapeHtml(object.reason)}` : ''}</p>`;
    const preview = object?.materialized && /^image\/(?:png|jpeg|gif|webp)$/i.test(reference.mediaType ?? '')
      ? `<img src="${escapeHtml(object.locator)}" alt="Evidence ${escapeHtml(reference.id)} preview — presentation only, not proof of a claim">`
      : '';
    return `<article><h3>${escapeHtml(reference.id)}</h3><dl><dt>Kind</dt><dd>${escapeHtml(reference.kind)}</dd><dt>Digest</dt><dd><code>${escapeHtml(reference.digest)}</code></dd><dt>Access</dt><dd>${reference.access.accessible ? 'accessible' : 'inaccessible'}; scope ${escapeHtml(reference.access.scope ?? 'not recorded')}${reference.access.expiresAt ? `; expires ${escapeHtml(reference.access.expiresAt)}` : ''}</dd><dt>Retention</dt><dd>${escapeHtml(reference.retention.policy)}${reference.retention.retainUntil ? ` through ${escapeHtml(reference.retention.retainUntil)}` : ''}</dd></dl>${objectLink}${preview}</article>`;
  }).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'">
<title>ProofShot claim review</title>
<style>
:root{color-scheme:light dark;font:100%/1.55 system-ui,sans-serif}body{max-width:72rem;margin:auto;padding:1.25rem;background:#fff;color:#17202a}a{color:#075fa8}.skip{position:absolute;left:-999rem}.skip:focus{left:1rem;top:1rem;background:#fff;color:#111;padding:.6rem;z-index:2}a:focus-visible,summary:focus-visible{outline:.2rem solid #b54708;outline-offset:.2rem}.banner,.claim,article,section{border:1px solid #65717d;border-radius:.5rem;padding:1rem;margin:1rem 0}.invalid,.fail,.blocked,.inconclusive,.not_observed{border-left:.5rem solid #a12622}.pass{border-left:.5rem solid #157f3b}.status{font-size:.8em;font-weight:700;letter-spacing:.04em}.context{font-style:italic}pre,code{overflow-wrap:anywhere}pre{white-space:pre-wrap;background:#edf1f4;color:#111;padding:1rem}dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem}dt{font-weight:700}dd{margin:0}img{display:block;max-width:100%;height:auto;margin-top:1rem;border:1px solid #65717d}@media(max-width:35rem){body{padding:.6rem}.banner,.claim,article,section{padding:.7rem}dl{display:block}dd{margin:0 0 .6rem}}@media(prefers-color-scheme:dark){body{background:#111820;color:#f4f7fa}a{color:#78bfff}pre{background:#202b35;color:#fff}}@media(forced-colors:active){.invalid,.fail,.blocked,.inconclusive,.not_observed,.pass{border-left-width:.5rem}}
</style></head><body>
<a class="skip" href="#main">Skip to claim review</a><header class="banner ${manifest.semanticStatus.valid ? escapeHtml(manifest.semanticStatus.result) : 'invalid'}"><h1>ProofShot claim review</h1><p><strong>Bundle contract:</strong> ${manifest.semanticStatus.valid ? 'VALID' : 'INVALID, FAIL CLOSED'}<br><strong>Claim rollup:</strong> ${escapeHtml(statusLabel(manifest.semanticStatus.result))}</p><p>This codec-independent view leads with semantic observations. Video, filenames, captions, storyboards, and contact sheets are context only.</p><p><a href="manifest.json">Open raw manifest JSON</a> · <a href="SUMMARY.md">Open raw text summary</a></p></header>
<main id="main"><section aria-labelledby="claims"><h2 id="claims">Claims</h2>${claims}</section>
<section aria-labelledby="observations"><h2 id="observations">Expected and actual observations</h2>${observations}</section>
<section aria-labelledby="boundaries"><h2 id="boundaries">Proof boundaries</h2><ul>${boundaries}</ul></section>
<section aria-labelledby="provenance"><h2 id="provenance">Provenance and capture health</h2><pre>${escapeHtml(JSON.stringify({ provenance: manifest.provenance, captureHealth: manifest.captureHealth }, null, 2))}</pre></section>
<section aria-labelledby="nonclaims"><h2 id="nonclaims">Nonclaims</h2><ul>${nonclaims}</ul></section>
<section aria-labelledby="evidence"><h2 id="evidence">Evidence references</h2>${evidence}</section>
<section aria-labelledby="issues"><h2 id="issues">Validation issues</h2><ul>${issues}</ul></section>
<section aria-labelledby="fallback"><h2 id="fallback">No-video fallback</h2><p>All semantic status, observations, boundaries, provenance, nonclaims, and raw data remain available without video playback, a codec, or a browser extension. WebM is optional.</p></section></main></body></html>`;
}

function validatePolicyEvidence(
  options: CompileReviewBundleOptions,
  validation: ProofBundleValidation,
  resolved: ReadonlyMap<string, { content?: Uint8Array | string; data?: Uint8Array; digestMatches: boolean }>,
): void {
  for (const [index, item] of options.bundle.evidence.entries()) {
    const actualSize = resolved.get(item.id)?.data?.byteLength;
    if (actualSize !== undefined && item.sizeBytes !== undefined && item.sizeBytes !== actualSize) {
      validation.errors.push({ code: 'declared_size_mismatch', path: `evidence[${index}].sizeBytes`, message: `Declared size ${item.sizeBytes} does not match ${actualSize} resolved bytes` });
    }
    if (actualSize !== undefined && actualSize > options.policy.budgets.perItemBytes) {
      validation.errors.push({ code: 'item_budget_exceeded', path: `evidence[${index}]`, message: `Resolved evidence is ${actualSize} bytes and exceeds the per-item budget` });
    }
    if (item.kind === 'browser' && item.mediaType?.startsWith('video/')
      && options.policy.privacy.rawBrowserVideo !== 'opt_in') {
      validation.errors.push({ code: 'raw_browser_video_not_opted_in', path: `evidence[${index}]`, message: 'Raw browser video requires explicit privacy opt-in' });
    }
    if (item.kind === 'terminal' && item.mediaType?.startsWith('video/')
      && options.policy.privacy.rawTerminalVideo !== 'opt_in') {
      validation.errors.push({ code: 'raw_terminal_video_not_opted_in', path: `evidence[${index}]`, message: 'Raw terminal video requires explicit privacy opt-in' });
    }
  }
  const uniqueVerified = new Map<string, number>();
  for (const item of options.bundle.evidence) {
    const value = resolved.get(item.id);
    if (value?.digestMatches && value.data) uniqueVerified.set(item.digest, value.data.byteLength);
  }
  const verifiedObjectBytes = [...uniqueVerified.values()].reduce((sum, size) => sum + size, 0);
  if (verifiedObjectBytes > options.policy.budgets.totalBytes) {
    validation.errors.push({ code: 'total_budget_exceeded', path: 'evidence', message: `Verified unique objects require ${verifiedObjectBytes} bytes and exceed the total budget` });
  }
  for (const kind of ['terminal', 'browser'] as const) {
    const expectedIds = options.bundle.expectedObservations
      .filter(({ requiredEvidence }) => requiredEvidence.includes(kind))
      .map(({ id }) => id);
    if (expectedIds.length === 0) continue;
    const health = options.captureHealth?.[kind] ?? 'not_observed';
    if (health !== 'observed') {
      validation.errors.push({
        code: health === 'blocked' ? 'capture_blocked' : 'capture_not_observed',
        path: `captureHealth.${kind}`,
        message: `${kind} capture required by the claim is ${health}`,
      });
    }
  }
  validation.errors.push(...policyIssues(options));
  validation.valid = validation.errors.length === 0;
  if (!validation.valid) {
    validation.claimResults = validation.claimResults.map((result) => {
      return result.status === 'pass' ? { ...result, status: 'inconclusive' } : result;
    });
  }
}

export async function compileReviewBundle(
  options: CompileReviewBundleOptions,
): Promise<CompiledReviewBundle> {
  const now = options.now ?? new Date();
  const resolved = new Map<string, {
    content?: Uint8Array | string;
    data?: Uint8Array;
    digestMatches: boolean;
  }>();
  for (const reference of options.bundle.evidence) {
    const content = resolveContent(options.evidence, reference);
    resolved.set(reference.id, {
      content,
      data: content === undefined ? undefined : bytes(content),
      digestMatches: content !== undefined && sha256Digest(content) === reference.digest,
    });
  }
  const validation = validateProofBundle(options.bundle, {
    now,
    resolveEvidence: (reference) => resolved.get(reference.id)?.content,
  });
  validatePolicyEvidence(options, validation, resolved);

  const objectMap = new Map<string, ReviewObject & { content: Uint8Array }>();
  for (const reference of options.bundle.evidence) {
    const value = resolved.get(reference.id);
    if (!value?.data || !value.digestMatches) continue;
    const data = value.data;
    const hash = reference.digest.slice('sha256:'.length);
    const existing = objectMap.get(reference.digest);
    if (existing) {
      existing.evidenceIds.push(reference.id);
      if (reference.mediaType && !existing.mediaTypes.includes(reference.mediaType)) existing.mediaTypes.push(reference.mediaType);
    } else {
      objectMap.set(reference.digest, {
        digest: reference.digest,
        locator: `objects/sha256/${hash}`,
        sizeBytes: data.byteLength,
        evidenceIds: [reference.id],
        mediaTypes: reference.mediaType ? [reference.mediaType] : [],
        materialized: true,
        content: data,
      });
    }
  }
  const objects = [...objectMap.values()];
  const totalBudgetValid = Number.isSafeInteger(options.policy.budgets.totalBytes)
    && options.policy.budgets.totalBytes > 0;
  const perItemBudgetValid = Number.isSafeInteger(options.policy.budgets.perItemBytes)
    && options.policy.budgets.perItemBytes > 0;
  const verifiedObjectBytes = objects.reduce((sum, item) => sum + item.sizeBytes, 0);
  for (const object of objects) {
    const references = object.evidenceIds
      .map((id) => options.bundle.evidence.find((item) => item.id === id))
      .filter((item): item is EvidenceReference => item !== undefined);
    const privacyBlocked = references.some((item) =>
      (item.kind === 'browser' && item.mediaType?.startsWith('video/')
        && options.policy.privacy.rawBrowserVideo !== 'opt_in')
      || (item.kind === 'terminal' && item.mediaType?.startsWith('video/')
        && options.policy.privacy.rawTerminalVideo !== 'opt_in'));
    if (privacyBlocked) {
      object.materialized = false;
      object.reason = 'raw video privacy opt-in is absent';
    } else if (!perItemBudgetValid || object.sizeBytes > options.policy.budgets.perItemBytes) {
      object.materialized = false;
      object.reason = 'per-item content budget is invalid or exceeded';
    } else if (!totalBudgetValid || verifiedObjectBytes > options.policy.budgets.totalBytes) {
      object.materialized = false;
      object.reason = 'total content budget is invalid or exceeded';
    }
  }
  const referencedBytes = [...resolved.values()].reduce((sum, item) => sum + (item.data?.byteLength ?? 0), 0);
  const manifest: ReviewManifest = {
    format: 'proofshot-review-bundle',
    version: '1.0.0',
    bundleId: options.bundle.id,
    createdAt: now.toISOString(),
    semanticStatus: {
      valid: validation.valid,
      result: claimRollup(validation.claimResults),
      claims: validation.claimResults.map((result) => ({
        ...result,
        statement: options.bundle.claims.find(({ id }) => id === result.claimId)?.statement
          ?? 'Claim statement missing',
      })),
      issues: validation.errors,
    },
    expectedObservations: options.bundle.expectedObservations,
    actualObservations: options.bundle.actualObservations,
    proofBoundaries: options.bundle.proofBoundaries,
    provenance: options.bundle.provenance,
    captureHealth: options.captureHealth ?? {},
    nonclaims: options.bundle.nonclaims,
    evidence: options.bundle.evidence,
    objects: objects.map(({ content: _content, ...object }) => object),
    policy: { ...options.policy, deduplication: 'sha256-content-addressed' },
    contentSize: {
      declaredBytes: options.bundle.evidence.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
      referencedBytes,
      storedBytes: objects.filter(({ materialized }) => materialized).reduce((sum, item) => sum + item.sizeBytes, 0),
      verifiedObjectBytes,
      itemCount: options.bundle.evidence.length,
      uniqueObjectCount: objects.length,
    },
    media: {
      postTrimDurationSeconds: options.postTrimMediaDurationSeconds ?? null,
      playbackOptional: true,
    },
    viewer: options.includeViewer === false ? null : 'viewer.html',
  };

  const output = resolve(options.outputDirectory);
  await mkdir(output, { recursive: true });
  for (const object of objects) {
    if (!object.materialized) continue;
    const target = join(output, object.locator);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, object.content, { mode: 0o600 });
  }
  const manifestPath = join(output, 'manifest.json');
  const summaryPath = join(output, 'SUMMARY.md');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await writeFile(summaryPath, renderSummary(manifest), { mode: 0o600 });
  let viewerPath: string | undefined;
  if (manifest.viewer) {
    viewerPath = join(output, manifest.viewer);
    await writeFile(viewerPath, renderViewer(manifest), { mode: 0o600 });
  }
  return { manifest, validation, paths: { manifest: manifestPath, summary: summaryPath, viewer: viewerPath } };
}
