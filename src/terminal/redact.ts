import { sha256Digest } from '../evidence/validate.js';
import type { RedactionManifestEntry } from './types.js';

export const REDACTED = '[REDACTED]';
const SECRET_NAME = /(?:token|secret|password|passwd|api[-_]?key|private[-_]?key|credential|authorization|cookie)/i;
const SENSITIVE_FLAG = /^(?:--?(?:token|secret|password|passwd|api[-_]?key|private[-_]?key|credential|authorization|cookie))$/i;
const ASSIGNMENT = /^([^=]+)=(.*)$/s;
const RESIDUAL = [
  { name: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/i },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'openai-token', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
] as const;

export interface RedactionPolicy {
  secretValues?: string[];
  sensitiveFlags?: string[];
  sensitiveEnvironmentNames?: string[];
}

function values(policy: RedactionPolicy): string[] {
  return [...new Set((policy.secretValues ?? []).filter((value) => value.length > 0))]
    .sort((a, b) => b.length - a.length);
}

function manifestEntry(
  location: RedactionManifestEntry['location'],
  classification: RedactionManifestEntry['classification'],
  count: number,
): RedactionManifestEntry[] {
  return count > 0 ? [{ location, classification, count }] : [];
}

export function redactTextDetailed(
  input: string,
  policy: RedactionPolicy = {},
  location: 'stdout' | 'stderr' | 'pty' | 'keystroke' = 'stdout',
): { text: string; manifest: RedactionManifestEntry[] } {
  let result = input;
  let count = 0;
  for (const value of values(policy)) {
    const parts = result.split(value);
    count += parts.length - 1;
    result = parts.join(REDACTED);
  }
  return { text: result, manifest: manifestEntry(location, 'explicit-secret', count) };
}

export function redactText(input: string, policy: RedactionPolicy = {}): string {
  return redactTextDetailed(input, policy).text;
}

export function redactArgvWithManifest(
  argv: readonly string[],
  policy: RedactionPolicy = {},
): { argv: string[]; secretValues: string[]; manifest: RedactionManifestEntry[] } {
  const flags = new Set((policy.sensitiveFlags ?? []).map((flag) => flag.toLowerCase()));
  const result: string[] = [];
  const secretValues = [...values(policy)];
  let sensitiveCount = 0;
  let explicitCount = 0;
  let redactNext = false;
  for (const raw of argv) {
    if (redactNext) {
      result.push(REDACTED);
      if (raw) secretValues.push(raw);
      sensitiveCount += 1;
      redactNext = false;
      continue;
    }
    const assignment = raw.match(ASSIGNMENT);
    if (assignment && (SENSITIVE_FLAG.test(assignment[1]) || flags.has(assignment[1].toLowerCase()))) {
      result.push(`${assignment[1]}=${REDACTED}`);
      if (assignment[2]) secretValues.push(assignment[2]);
      sensitiveCount += 1;
      continue;
    }
    const redacted = redactTextDetailed(raw, policy);
    result.push(redacted.text);
    explicitCount += redacted.manifest.reduce((sum, entry) => sum + entry.count, 0);
    if (SENSITIVE_FLAG.test(raw) || flags.has(raw.toLowerCase())) redactNext = true;
  }
  return {
    argv: result,
    secretValues: [...new Set(secretValues)],
    manifest: [
      ...manifestEntry('argv', 'sensitive-flag', sensitiveCount),
      ...manifestEntry('argv', 'explicit-secret', explicitCount),
    ],
  };
}

export function redactArgv(argv: readonly string[], policy: RedactionPolicy = {}): string[] {
  return redactArgvWithManifest(argv, policy).argv;
}

export function redactEnvironment(
  environment: Record<string, string | undefined>,
  allowlist: readonly string[],
  policy: RedactionPolicy = {},
): {
  allowlisted: Record<string, string>;
  digest: `sha256:${string}`;
  secretValues: string[];
  manifest: RedactionManifestEntry[];
} {
  const sensitiveNames = new Set((policy.sensitiveEnvironmentNames ?? []).map((name) => name.toLowerCase()));
  const allowlisted: Record<string, string> = {};
  const secretValues = [...values(policy)];
  let sensitiveCount = 0;
  for (const name of [...allowlist].sort()) {
    const value = environment[name];
    if (value !== undefined && (SECRET_NAME.test(name) || sensitiveNames.has(name.toLowerCase()))) {
      secretValues.push(value);
    }
  }
  for (const name of [...allowlist].sort()) {
    const value = environment[name];
    if (value === undefined) continue;
    if (SECRET_NAME.test(name) || sensitiveNames.has(name.toLowerCase())) {
      allowlisted[name] = REDACTED;
      sensitiveCount += 1;
    } else {
      allowlisted[name] = redactText(value, { ...policy, secretValues });
    }
  }
  return {
    allowlisted,
    digest: sha256Digest(JSON.stringify(allowlisted)),
    secretValues: [...new Set(secretValues)],
    manifest: manifestEntry('environment', 'sensitive-environment', sensitiveCount),
  };
}

export function scanResidualSecrets(value: unknown): { passed: boolean; findings: string[] } {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const findings = RESIDUAL.filter(({ pattern }) => pattern.test(serialized)).map(({ name }) => name);
  return { passed: findings.length === 0, findings };
}
