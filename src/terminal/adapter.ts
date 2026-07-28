import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256Digest } from '../evidence/validate.js';
import type { NonGitSourceIdentity } from '../evidence/contract.js';
import type { SourceIdentity } from '../evidence/contract.js';
import { PROOFSHOT_VERSION } from '../version.js';
import {
  redactArgvWithManifest,
  redactEnvironment,
  redactText,
  redactTextDetailed,
  scanResidualSecrets,
  type RedactionPolicy,
} from './redact.js';
import type {
  JsonOutcome,
  RedactionManifestEntry,
  SanitizedKeystroke,
  TerminalGeneratedArtifact,
  TerminalObservation,
} from './types.js';

const execFileAsync = promisify(execFile);

export interface CaptureTerminalOptions {
  argv: [string, ...string[]];
  cwd?: string;
  environment?: Record<string, string | undefined>;
  environmentAllowlist?: string[];
  redaction?: RedactionPolicy;
  timeoutMilliseconds?: number;
  expectedJson?: boolean;
  validateJson?: (value: unknown) => boolean;
  scenarioId?: string;
  configurationIdentity?: string;
  source?: SourceIdentity;
  toolVersions?: Record<string, string>;
  terminal?: {
    rows?: number;
    columns?: number;
    color?: boolean;
    glyphs?: 'unicode' | 'ascii';
    term?: string;
    locale?: string;
  };
  keystrokes?: Array<{
    key?: string;
    text?: string;
    atMilliseconds?: number;
    secret?: boolean;
  }>;
  generatedArtifacts?: GeneratedArtifactInput[];
  /** Test/host integration seam; receives structured argv and must not invoke a shell. */
  executor?: (
    executable: string,
    args: string[],
    options: { cwd: string; env: Record<string, string>; timeoutMilliseconds?: number },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number; signal?: string }>;
}

export interface GeneratedArtifactInput {
  id?: string;
  kind: 'file' | 'url';
  locator: string;
  mediaType: string;
  /** Read-only source for the captured bytes. Relative paths resolve from cwd. */
  sourcePath?: string;
  content?: string | Uint8Array;
}

async function nonGitSource(cwd: string): Promise<NonGitSourceIdentity> {
  return { kind: 'non_git', locator: `file://${cwd}` };
}

function sanitizeKeystrokes(
  values: CaptureTerminalOptions['keystrokes'] = [],
  policy: RedactionPolicy = {},
): { keystrokes: SanitizedKeystroke[]; manifest: RedactionManifestEntry[] } {
  let suppressed = 0;
  let explicitCount = 0;
  const keystrokes = values.map((value, sequence): SanitizedKeystroke => {
    if (value.secret) {
      suppressed += 1;
      return { sequence, atMilliseconds: value.atMilliseconds, secretEntry: true };
    }
    const text = value.text === undefined
      ? undefined
      : redactTextDetailed(value.text, policy, 'keystroke');
    explicitCount += text?.manifest.reduce((sum, item) => sum + item.count, 0) ?? 0;
    return {
      sequence,
      atMilliseconds: value.atMilliseconds,
      key: value.key,
      text: text?.text,
      secretEntry: false,
    };
  });
  return {
    keystrokes,
    manifest: [
      ...(suppressed > 0
        ? [{ location: 'keystroke' as const, classification: 'secret-keystroke' as const, count: suppressed }]
        : []),
      ...(explicitCount > 0
        ? [{ location: 'keystroke' as const, classification: 'explicit-secret' as const, count: explicitCount }]
        : []),
    ],
  };
}

async function normalizeGeneratedArtifacts(
  inputs: GeneratedArtifactInput[] = [],
  cwd: string,
  policy: RedactionPolicy,
): Promise<TerminalGeneratedArtifact[]> {
  return Promise.all(inputs.map(async (input, index) => {
    if (redactTextDetailed(input.locator, policy).text !== input.locator) {
      throw new Error('Generated artifact locator contains secret material; capture failed closed');
    }
    if (input.kind === 'url' && input.content === undefined && !input.sourcePath) {
      throw new Error(`URL artifact ${input.locator} requires captured content or sourcePath`);
    }
    const bytes = input.content !== undefined
      ? (typeof input.content === 'string' ? Buffer.from(input.content) : Buffer.from(input.content))
      : await readFile(resolve(cwd, input.sourcePath ?? input.locator));
    if (/^(?:text\/|application\/(?:json|xml|javascript))/.test(input.mediaType)) {
      const text = bytes.toString('utf8');
      if (redactTextDetailed(text, policy).text !== text || !scanResidualSecrets(text).passed) {
        throw new Error(`Generated artifact ${input.locator} contains secret material; capture failed closed`);
      }
    }
    return {
      id: input.id ?? `generated-${index + 1}`,
      kind: input.kind,
      locator: input.locator,
      mediaType: input.mediaType,
      digest: sha256Digest(bytes),
      sizeBytes: bytes.byteLength,
    };
  }));
}

export async function captureTerminal(options: CaptureTerminalOptions): Promise<TerminalObservation> {
  if (!options.argv.length) throw new Error('argv must contain an executable');
  const cwd = resolve(options.cwd ?? process.cwd());
  const startedWall = new Date();
  const startedMono = process.hrtime.bigint();
  const envInput = options.environment ?? process.env;
  const env = Object.fromEntries(Object.entries(envInput).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const preliminaryArgv = redactArgvWithManifest(options.argv, options.redaction);
  const boundary = redactEnvironment(
    envInput,
    options.environmentAllowlist ?? ['LANG', 'LC_ALL', 'TERM', 'NO_COLOR'],
    { ...options.redaction, secretValues: preliminaryArgv.secretValues },
  );
  const policy = {
    ...options.redaction,
    secretValues: [...preliminaryArgv.secretValues, ...boundary.secretValues],
  };
  const argvResult = redactArgvWithManifest(options.argv, policy);
  const argv = argvResult.argv;
  const redactionManifest: RedactionManifestEntry[] = [
    ...argvResult.manifest,
    ...boundary.manifest,
  ];
  let stdout = '';
  let stderr = '';
  let outcome: TerminalObservation['outcome'];
  try {
    const completed: { stdout: string; stderr: string; exitCode: number; signal?: string } = options.executor
      ? await options.executor(options.argv[0], options.argv.slice(1), { cwd, env, timeoutMilliseconds: options.timeoutMilliseconds })
      : await execFileAsync(options.argv[0], options.argv.slice(1), {
        cwd, env, encoding: 'utf8', timeout: options.timeoutMilliseconds,
        maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      }).then((value) => ({ ...value, exitCode: 0 }));
    const redactedStdout = redactTextDetailed(completed.stdout, policy, 'stdout');
    const redactedStderr = redactTextDetailed(completed.stderr, policy, 'stderr');
    stdout = redactedStdout.text;
    stderr = redactedStderr.text;
    redactionManifest.push(...redactedStdout.manifest, ...redactedStderr.manifest);
    outcome = {
      kind: completed.signal ? 'signal' : 'exit', exitCode: completed.exitCode,
      ...(completed.signal ? { signal: completed.signal } : {}),
      startedAt: startedWall.toISOString(), completedAt: new Date().toISOString(),
      timeSource: 'captured', durationMilliseconds: 0, encoding: 'utf-8', streams: 'separate',
      stdout, stderr,
    };
  } catch (error: any) {
    const redactedStdout = redactTextDetailed(typeof error?.stdout === 'string' ? error.stdout : '', policy, 'stdout');
    const redactedStderr = redactTextDetailed(typeof error?.stderr === 'string' ? error.stderr : '', policy, 'stderr');
    stdout = redactedStdout.text;
    stderr = redactedStderr.text;
    redactionManifest.push(...redactedStdout.manifest, ...redactedStderr.manifest);
    const timedOut = Boolean(error?.killed) && options.timeoutMilliseconds !== undefined;
    const spawnError = error?.code === 'ENOENT' || error?.code === 'EACCES'
      || (typeof error?.code !== 'number' && !error?.signal && !timedOut);
    outcome = {
      kind: timedOut ? 'timeout' : spawnError ? 'spawn_error' : error?.signal ? 'signal' : 'exit',
      ...(typeof error?.code === 'number' ? { exitCode: error.code } : {}),
      ...(error?.signal ? { signal: String(error.signal) } : {}),
      ...(spawnError ? { spawnError: { code: String(error.code), message: redactText(String(error.message), policy) } } : {}),
      startedAt: startedWall.toISOString(),
      completedAt: new Date().toISOString(),
      timeSource: 'captured', durationMilliseconds: 0, encoding: 'utf-8', streams: 'separate',
      stdout,
      stderr,
    };
  }
  outcome.durationMilliseconds = Number(process.hrtime.bigint() - startedMono) / 1e6;
  if (options.expectedJson) {
    const json: JsonOutcome = {
      exactStdout: stdout,
      redacted: redactionManifest.some((entry) => entry.location === 'stdout'),
      parsed: false,
      schema: 'not_checked',
    };
    try {
      const parsed: unknown = JSON.parse(stdout);
      json.parsed = true;
      json.schema = options.validateJson ? (options.validateJson(parsed) ? 'valid' : 'invalid') : 'not_checked';
    } catch (error: any) {
      json.error = redactText(String(error?.message ?? error), policy);
    }
    outcome.json = json;
  }
  const interaction = sanitizeKeystrokes(options.keystrokes, policy);
  redactionManifest.push(...interaction.manifest);
  outcome.suppressedSecretKeystrokes = interaction.keystrokes.filter((item) => item.secretEntry).length;
  const generatedArtifacts = await normalizeGeneratedArtifacts(options.generatedArtifacts, cwd, policy);
  const observation: TerminalObservation = {
    schemaVersion: '1.0.0',
    id: randomUUID(),
    scenarioId: options.scenarioId ?? 'direct-command',
    runner: 'proofshot-exec-file',
    command: { argv, cwd },
    environment: { allowlisted: boundary.allowlisted, digest: boundary.digest },
    source: options.source ?? await nonGitSource(cwd),
    runtime: {
      name: 'node', version: process.version,
      toolVersions: { proofshot: PROOFSHOT_VERSION, ...options.toolVersions },
      configurationIdentity: options.configurationIdentity,
    },
    terminal: {
      mode: 'pipe',
      modeEvidence: 'captured',
      rows: options.terminal?.rows,
      columns: options.terminal?.columns,
      color: options.terminal?.color ?? !('NO_COLOR' in env),
      glyphs: options.terminal?.glyphs ?? 'unicode',
      term: options.terminal?.term ?? env.TERM,
      locale: options.terminal?.locale ?? env.LC_ALL ?? env.LANG,
    },
    outcome,
    status: outcome.kind === 'exit'
      ? (outcome.exitCode === 0 ? 'pass' : 'fail')
      : outcome.kind === 'timeout' || outcome.kind === 'spawn_error'
        ? 'blocked'
        : 'inconclusive',
    residualSecretScan: { passed: true, findings: [] },
    redactionManifest,
    keystrokes: interaction.keystrokes,
    generatedArtifacts,
    replay: {
      argvKnown: true, cwdKnown: true, environmentKnown: true, terminalKnown: true,
      inputs: {
        argv,
        cwd,
        environment: boundary.allowlisted,
        terminal: {
          mode: 'pipe',
          rows: options.terminal?.rows ?? null,
          columns: options.terminal?.columns ?? null,
          color: options.terminal?.color ?? !('NO_COLOR' in env),
          glyphs: options.terminal?.glyphs ?? 'unicode',
        },
      },
      nonclaims: [
        'External state is not captured.',
        'Scheduling, timing, and other nondeterminism are not reproduced.',
        'Generated artifact bytes are identified but replay does not recreate their producer dependencies.',
      ],
    },
  };
  const serializedObservation = JSON.stringify(observation);
  if (redactTextDetailed(serializedObservation, policy).text !== serializedObservation) {
    throw new Error('Explicit secret remained after structured terminal redaction; capture failed closed');
  }
  observation.residualSecretScan = scanResidualSecrets(observation);
  if (!observation.residualSecretScan.passed) throw new Error(`Residual secret detection failed: ${observation.residualSecretScan.findings.join(', ')}`);
  return observation;
}
