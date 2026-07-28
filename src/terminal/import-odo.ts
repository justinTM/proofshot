import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256Digest, validateProofBundle } from '../evidence/validate.js';
import {
  PROOF_BUNDLE_CONTRACT_VERSION,
  type EvidenceKind,
  type EvidenceReference,
  type JsonValue,
  type ProofBundle,
  type SourceIdentity,
} from '../evidence/contract.js';
import {
  redactArgvWithManifest,
  redactEnvironment,
  redactTextDetailed,
  scanResidualSecrets,
  type RedactionPolicy,
} from './redact.js';
import type {
  OrderedTerminalEvent,
  PortableTerminalBundle,
  RedactionManifestEntry,
  SanitizedKeystroke,
  TerminalContext,
  TerminalGeneratedArtifact,
  TerminalObservation,
} from './types.js';

export interface OdoRunResult {
  scenario_id: string;
  runner: string;
  command: string[];
  status: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_seconds: number;
  detail?: string;
  /** Optional future extension. Current PTY records place the merged stream in stdout. */
  terminal_events?: OrderedTerminalEvent[];
  [key: string]: unknown;
}

export interface DeclaredTerminalContext {
  mode: 'pipe' | 'pty';
  rows?: number;
  columns?: number;
  color: boolean;
  glyphs: 'unicode' | 'ascii';
  term?: string;
  locale?: string;
}

export interface ImportedGeneratedArtifact {
  id?: string;
  kind: 'file' | 'url';
  locator: string;
  mediaType: string;
  sourcePath?: string;
  content?: string;
}

export interface ImportedKeystroke {
  key?: string;
  text?: string;
  atMilliseconds?: number;
  secret?: boolean;
}

export interface ImportOdoOptions {
  input: string;
  outputDirectory: string;
  cwd: string;
  redaction?: RedactionPolicy;
  source?: SourceIdentity;
  /** Explicit fallback context. PTY is never inferred from a runner name. */
  terminalMode?: 'pipe' | 'pty';
  rows?: number;
  columns?: number;
  color?: boolean;
  glyphs?: 'unicode' | 'ascii';
  terminalContexts?: Record<string, DeclaredTerminalContext>;
  environment?: Record<string, string>;
  configurationIdentity?: string;
  generatedArtifacts?: Record<string, ImportedGeneratedArtifact[]>;
  keystrokes?: Record<string, ImportedKeystroke[]>;
  now?: Date;
}

interface PendingEvidence {
  reference: EvidenceReference;
  bytes: Buffer;
}

function assertRunResult(value: unknown, line: number): asserts value is OdoRunResult {
  const item = value as OdoRunResult;
  if (!item || typeof item !== 'object'
    || typeof item.scenario_id !== 'string' || typeof item.runner !== 'string'
    || !Array.isArray(item.command) || !item.command.every((part) => typeof part === 'string')
    || typeof item.status !== 'string' || !(typeof item.exit_code === 'number' || item.exit_code === null)
    || typeof item.stdout !== 'string' || typeof item.stderr !== 'string'
    || typeof item.duration_seconds !== 'number' || item.duration_seconds < 0
    || (item.terminal_events !== undefined && (
      !Array.isArray(item.terminal_events)
      || !item.terminal_events.every((event) => event
        && typeof event.sequence === 'number'
        && event.stream === 'pty'
        && typeof event.text === 'string')
    ))) {
    throw new Error(`Invalid ODO RunResult at JSONL line ${line}`);
  }
}

function declaredContext(record: OdoRunResult, options: ImportOdoOptions): TerminalContext {
  const keys = [`${record.runner}:${record.scenario_id}`, record.scenario_id, record.runner];
  const declared = keys.map((key) => options.terminalContexts?.[key]).find(Boolean);
  const environment = options.environment ?? {};
  if (declared) return {
    ...declared,
    modeEvidence: 'declared',
    term: declared.term ?? environment.TERM,
    locale: declared.locale ?? environment.LC_ALL ?? environment.LANG,
  };
  if (!options.terminalMode) {
    throw new Error(`Terminal context must be declared for ${record.runner}:${record.scenario_id}`);
  }
  return {
    mode: options.terminalMode,
    modeEvidence: 'declared',
    rows: options.rows,
    columns: options.columns,
    color: options.color ?? !('NO_COLOR' in environment),
    glyphs: options.glyphs ?? 'unicode',
    term: environment.TERM,
    locale: environment.LC_ALL ?? environment.LANG,
  };
}

function conclusion(status: string): 'matches' | 'contradicts' | 'blocked' | 'ambiguous' {
  if (status === 'pass') return 'matches';
  if (status.startsWith('blocked')) return 'blocked';
  if (status === 'fail') return 'contradicts';
  return 'ambiguous';
}

function sourceFor(cwd: string, supplied?: SourceIdentity): SourceIdentity {
  return supplied ?? { kind: 'non_git', locator: `file://${cwd}` };
}

function sanitizeKeystrokes(
  values: ImportedKeystroke[] = [],
  policy: RedactionPolicy = {},
): { values: SanitizedKeystroke[]; manifest: RedactionManifestEntry[] } {
  let count = 0;
  let explicitCount = 0;
  const sanitized = values.map((value, sequence): SanitizedKeystroke => {
    if (value.secret) {
      count += 1;
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
    values: sanitized,
    manifest: [
      ...(count > 0
        ? [{ location: 'keystroke' as const, classification: 'secret-keystroke' as const, count }]
        : []),
      ...(explicitCount > 0
        ? [{ location: 'keystroke' as const, classification: 'explicit-secret' as const, count: explicitCount }]
        : []),
    ],
  };
}

async function loadGeneratedArtifacts(
  values: ImportedGeneratedArtifact[] = [],
  cwd: string,
  policy: RedactionPolicy,
): Promise<Array<{ record: TerminalGeneratedArtifact; bytes: Buffer }>> {
  return Promise.all(values.map(async (value, index) => {
    if (redactTextDetailed(value.locator, policy).text !== value.locator) {
      throw new Error('Generated artifact locator contains secret material; import failed closed');
    }
    if (value.kind === 'url' && value.content === undefined && !value.sourcePath) {
      throw new Error(`URL artifact ${value.locator} requires captured content or sourcePath`);
    }
    const bytes = value.content !== undefined
      ? Buffer.from(value.content)
      : await readFile(resolve(cwd, value.sourcePath ?? value.locator));
    const asText = /^(?:text\/|application\/(?:json|xml|javascript))/.test(value.mediaType)
      ? bytes.toString('utf8')
      : undefined;
    if (asText !== undefined) {
      const explicit = redactTextDetailed(asText, policy);
      const residual = scanResidualSecrets(asText);
      if (explicit.text !== asText || !residual.passed) {
        throw new Error(`Generated artifact ${value.locator} contains secret material; capture failed closed`);
      }
    }
    return {
      record: {
        id: value.id ?? `generated-${index + 1}`,
        kind: value.kind,
        locator: value.locator,
        mediaType: value.mediaType,
        digest: sha256Digest(bytes),
        sizeBytes: bytes.byteLength,
      },
      bytes,
    };
  }));
}

function evidenceReference(
  id: string,
  kind: EvidenceKind,
  uri: string,
  mediaType: string,
  bytes: Buffer,
  observation: TerminalObservation,
  createdAt: Date,
  redactionApplied: boolean,
): EvidenceReference {
  const adapter = { namespace: 'dev.noaa.oiss.odo-cli-matrix', version: '1.0.0' };
  return {
    id,
    kind,
    uri,
    digest: sha256Digest(bytes),
    sizeBytes: bytes.byteLength,
    mediaType,
    provenance: {
      producer: 'proofshot terminal import-odo',
      producedAt: createdAt.toISOString(),
      adapter,
      source: observation.source,
    },
    adapter,
    access: { accessible: true, checkedAt: createdAt.toISOString(), scope: 'portable bundle' },
    retention: { policy: 'caller-managed' },
    redaction: {
      policy: 'proofshot-terminal-v1',
      applied: redactionApplied,
      description: 'Structured values were classified before persistence; residual scan passed.',
    },
    metadata: { producerObservationIds: [observation.id] },
  };
}

export async function importOdoCliMatrix(options: ImportOdoOptions): Promise<PortableTerminalBundle> {
  const input = resolve(options.input);
  const output = resolve(options.outputDirectory);
  const cwd = resolve(options.cwd);
  const raw = await readFile(input, 'utf8');
  const records = raw.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    let value: unknown;
    try { value = JSON.parse(line); } catch (error: any) {
      throw new Error(`Malformed runs.jsonl at line ${index + 1}: ${error.message}`);
    }
    assertRunResult(value, index + 1);
    return [value];
  });
  if (records.length === 0) throw new Error('ODO runs.jsonl contains no completed records');

  const createdAt = options.now ?? new Date();
  const environmentInput = options.environment ?? {};
  const observations: TerminalObservation[] = [];
  const artifactBytesByObservation = new Map<string, Array<{ record: TerminalGeneratedArtifact; bytes: Buffer }>>();

  for (const [index, record] of records.entries()) {
    const preliminaryArgv = redactArgvWithManifest(record.command, options.redaction);
    const environment = redactEnvironment(
      environmentInput,
      Object.keys(environmentInput),
      { ...options.redaction, secretValues: preliminaryArgv.secretValues },
    );
    const policy = {
      ...options.redaction,
      secretValues: [...preliminaryArgv.secretValues, ...environment.secretValues],
    };
    const argv = redactArgvWithManifest(record.command, policy);
    const stdout = redactTextDetailed(record.stdout, policy, 'stdout');
    const stderr = redactTextDetailed(record.stderr, policy, 'stderr');
    const detail = redactTextDetailed(record.detail ?? '', policy, 'stderr');
    const terminal = declaredContext(record, options);
    const completedAt = createdAt.toISOString();
    const startedAt = new Date(createdAt.getTime() - record.duration_seconds * 1000).toISOString();
    const redactionManifest = [
      ...argv.manifest,
      ...environment.manifest,
      ...stdout.manifest,
      ...stderr.manifest,
      ...detail.manifest,
    ];
    const interaction = sanitizeKeystrokes(options.keystrokes?.[record.scenario_id], policy);
    redactionManifest.push(...interaction.manifest);

    const outcome: TerminalObservation['outcome'] = {
      kind: /timed out|timeout/i.test(record.detail ?? '')
        ? 'timeout'
        : record.exit_code === null
          ? 'spawn_error'
          : 'exit',
      ...(record.exit_code !== null ? { exitCode: record.exit_code } : {}),
      ...(record.exit_code === null
        ? { spawnError: { message: detail.text || 'Runner did not report an exit code' } }
        : {}),
      startedAt,
      completedAt,
      timeSource: 'import_inferred',
      durationMilliseconds: record.duration_seconds * 1000,
      encoding: 'utf-8',
      streams: terminal.mode === 'pty' ? 'pty_merged' : 'separate',
      suppressedSecretKeystrokes: interaction.manifest.reduce((sum, item) => sum + item.count, 0),
    };

    if (terminal.mode === 'pty') {
      if (record.stderr !== '' && !record.terminal_events) {
        throw new Error(`PTY record ${record.scenario_id} lacks ordered merged events; refusing to invent stream order`);
      }
      if (record.terminal_events) {
        outcome.events = record.terminal_events.map((event) => {
          const redacted = redactTextDetailed(event.text, policy, 'pty');
          redactionManifest.push(...redacted.manifest);
          return { ...event, text: redacted.text };
        });
      } else {
        outcome.events = [{ sequence: 0, stream: 'pty', text: stdout.text }];
      }
    } else {
      outcome.stdout = stdout.text;
      outcome.stderr = stderr.text;
      if (/json/i.test(record.scenario_id) || argv.argv.includes('--json')) {
        outcome.json = {
          exactStdout: stdout.text,
          redacted: stdout.manifest.length > 0,
          parsed: false,
          schema: 'not_checked',
        };
        try { JSON.parse(stdout.text); outcome.json.parsed = true; } catch (error: any) {
          outcome.json.error = String(error.message);
        }
      }
    }

    const id = `odo-${index + 1}-${sha256Digest(`${record.runner}:${record.scenario_id}`).slice(7, 19)}`;
    const generated = await loadGeneratedArtifacts(
      options.generatedArtifacts?.[record.scenario_id],
      cwd,
      policy,
    );
    const observation: TerminalObservation = {
      schemaVersion: '1.0.0',
      id,
      scenarioId: record.scenario_id,
      runner: record.runner,
      command: { argv: argv.argv, cwd },
      environment: { allowlisted: environment.allowlisted, digest: environment.digest },
      source: sourceFor(cwd, options.source),
      runtime: { name: 'odo-cli-matrix', configurationIdentity: options.configurationIdentity },
      terminal,
      outcome,
      status: record.status,
      detail: detail.text,
      residualSecretScan: { passed: true, findings: [] },
      redactionManifest,
      keystrokes: interaction.values,
      generatedArtifacts: generated.map(({ record: item }) => item),
      replay: {
        argvKnown: true,
        cwdKnown: true,
        environmentKnown: options.environment !== undefined,
        terminalKnown: true,
        inputs: {
          argv: argv.argv,
          cwd,
          environment: environment.allowlisted,
          terminal: terminal as unknown as JsonValue,
        },
        nonclaims: [
          'External services and mutable external state are not captured.',
          'Timing, scheduling, and other nondeterminism are not replayed.',
          'Imported wall timestamps are inferred from import time and recorded duration.',
        ],
      },
    };
    const serializedObservation = JSON.stringify(observation);
    if (redactTextDetailed(serializedObservation, policy).text !== serializedObservation) {
      throw new Error(`Explicit secret remained after redaction for ${record.scenario_id}; import failed closed`);
    }
    observation.residualSecretScan = scanResidualSecrets(observation);
    if (!observation.residualSecretScan.passed) {
      throw new Error(`Residual secret detection failed for ${record.scenario_id}: ${observation.residualSecretScan.findings.join(', ')}`);
    }
    observations.push(observation);
    artifactBytesByObservation.set(id, generated);
  }

  const pending: PendingEvidence[] = [];
  const evidenceIdsByObservation = new Map<string, string[]>();
  for (const observation of observations) {
    const observationPending: PendingEvidence[] = [];
    const recordBytes = Buffer.from(`${JSON.stringify(observation, null, 2)}\n`);
    observationPending.push({
      reference: evidenceReference(
        `terminal-${observation.id}`,
        'terminal',
        `evidence/${observation.id}.terminal.json`,
        'application/vnd.proofshot.terminal-observation+json',
        recordBytes,
        observation,
        createdAt,
        observation.redactionManifest.length > 0,
      ),
      bytes: recordBytes,
    });

    if (observation.outcome.streams === 'separate') {
      for (const stream of ['stdout', 'stderr'] as const) {
        const bytes = Buffer.from(observation.outcome[stream] ?? '');
        observationPending.push({
          reference: evidenceReference(
            `${stream}-${observation.id}`,
            'terminal',
            `evidence/${observation.id}.${stream}.txt`,
            'text/plain; charset=utf-8',
            bytes,
            observation,
            createdAt,
            observation.redactionManifest.some((entry) => entry.location === stream),
          ),
          bytes,
        });
      }
    } else {
      const bytes = Buffer.from(`${JSON.stringify(observation.outcome.events ?? [], null, 2)}\n`);
      observationPending.push({
        reference: evidenceReference(
          `pty-${observation.id}`,
          'terminal',
          `evidence/${observation.id}.pty.json`,
          'application/json',
          bytes,
          observation,
          createdAt,
          observation.redactionManifest.some((entry) => entry.location === 'pty'),
        ),
        bytes,
      });
    }

    for (const generated of artifactBytesByObservation.get(observation.id) ?? []) {
      const uri = `evidence/${observation.id}.${generated.record.id}.artifact`;
      const reference = evidenceReference(
        `artifact-${observation.id}-${generated.record.id}`,
        generated.record.kind === 'url' ? 'url' : 'generated_file',
        uri,
        generated.record.mediaType,
        generated.bytes,
        observation,
        createdAt,
        false,
      );
      reference.metadata = {
        ...reference.metadata,
        originalLocator: generated.record.locator,
        artifactDigest: generated.record.digest,
      };
      observationPending.push({ reference, bytes: generated.bytes });
    }

    pending.push(...observationPending);
    evidenceIdsByObservation.set(observation.id, observationPending.map(({ reference }) => reference.id));
  }

  const adapter = { namespace: 'dev.noaa.oiss.odo-cli-matrix', version: '1.0.0' };
  const producer = 'proofshot terminal import-odo';
  const actuals = observations.map((observation, index) => ({
    id: `actual-${observation.id}`,
    expectedObservationId: `expected-${observation.id}`,
    startedAt: observation.outcome.startedAt,
    completedAt: observation.outcome.completedAt,
    collectionOutcome: (
      observation.outcome.kind === 'timeout'
        ? 'timed_out'
        : observation.outcome.kind === 'spawn_error'
          ? 'failed'
          : 'completed'
    ) as 'completed' | 'failed' | 'timed_out',
    conclusion: observation.outcome.kind === 'timeout' || observation.outcome.kind === 'spawn_error'
      ? (observation.status.startsWith('blocked') ? 'blocked' : 'ambiguous')
      : conclusion(observation.status),
    description: `Imported completed ODO cli_matrix outcome for ${observation.scenarioId}`,
    observedValue: observation as unknown as JsonValue,
    evidenceIds: evidenceIdsByObservation.get(observation.id) ?? [],
    proofBoundaryIds: ['local-runtime'],
    provenance: { producer, producedAt: createdAt.toISOString(), adapter, source: observation.source },
    provenanceDrift: { detected: false },
    metadata: {
      nativeScenarioId: observation.scenarioId,
      nativeRunner: observation.runner,
      nativeStatus: observation.status,
      importedTimestampSource: observation.outcome.timeSource,
      ordinal: index,
    },
  }));
  const proof: ProofBundle = {
    contractVersion: PROOF_BUNDLE_CONTRACT_VERSION,
    id: randomUUID(),
    createdAt: createdAt.toISOString(),
    provenance: { producer, producedAt: createdAt.toISOString(), adapter, source: sourceFor(cwd, options.source) },
    claims: observations.map((item) => ({
      id: `claim-${item.id}`,
      statement: `ODO scenario ${item.scenarioId} produced the imported native outcome`,
      expectedObservationIds: [`expected-${item.id}`],
      actualObservationIds: [`actual-${item.id}`],
    })),
    expectedObservations: observations.map((item) => ({
      id: `expected-${item.id}`,
      description: `Preserve ODO-owned expectation and native outcome for ${item.scenarioId}`,
      expectation: { evaluator: adapter, predicate: { nativeStatus: item.status } },
      requiredEvidence: ['terminal'],
    })),
    actualObservations: actuals,
    evidence: pending.map(({ reference }) => reference),
    proofBoundaries: [{
      id: 'local-runtime',
      kind: 'local_runtime',
      description: 'Completed outcomes imported from a local ODO cli_matrix JSONL run.',
      exercised: true,
      observationIds: actuals.map(({ id }) => id),
      evidenceIds: pending.map(({ reference }) => reference.id),
      doesNotProve: [
        'Stakeholder acceptance',
        'External-state reproducibility',
        'Correctness beyond the ODO-owned scenario expectation',
        'Exact original wall-clock timestamps',
      ],
    }],
    nonclaims: [
      {
        id: 'external-state',
        statement: 'External state is reproducible.',
        reason: 'The importer records known inputs but does not snapshot external systems.',
        proofBoundaryIds: ['local-runtime'],
      },
      {
        id: 'native-ownership',
        statement: 'ProofShot owns ODO scenario semantics.',
        reason: 'Native scenario IDs, statuses, runners, and details remain ODO-owned.',
      },
      {
        id: 'wall-time',
        statement: 'Imported wall timestamps are original capture timestamps.',
        reason: 'Current ODO RunResult records duration but not wall timestamps.',
        proofBoundaryIds: ['local-runtime'],
      },
    ],
  };
  const contents = new Map(pending.map(({ reference, bytes }) => [reference.uri, bytes]));
  const validation = validateProofBundle(proof, {
    now: createdAt,
    resolveEvidence: (reference) => contents.get(reference.uri),
  });
  if (!validation.valid) {
    throw new Error(`Compiled terminal proof is invalid: ${validation.errors.map((error) => error.code).join(', ')}`);
  }

  const portable: PortableTerminalBundle = {
    format: 'proofshot-terminal-bundle',
    version: '1.0.0',
    observations,
    proof,
  };
  const bundleBytes = Buffer.from(`${JSON.stringify(portable, null, 2)}\n`);
  await mkdir(resolve(output, 'evidence'), { recursive: true });
  for (const item of pending) {
    await writeFile(resolve(output, item.reference.uri), item.bytes, { mode: 0o600 });
  }
  await writeFile(resolve(output, 'bundle.json'), bundleBytes, { mode: 0o600 });
  await writeFile(resolve(output, 'manifest.json'), `${JSON.stringify({
    mediaType: 'application/vnd.proofshot.terminal-bundle+json',
    locator: 'bundle.json',
    digest: sha256Digest(bundleBytes),
    evidence: pending.map(({ reference }) => ({
      id: reference.id,
      locator: reference.uri,
      digest: reference.digest,
      mediaType: reference.mediaType,
    })),
    producerObservationIds: observations.map(({ id }) => id),
    source: { digest: sha256Digest(raw), recordCount: records.length },
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return portable;
}
