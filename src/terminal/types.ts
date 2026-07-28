import type { JsonValue, ProofBundle, Sha256Digest, SourceIdentity } from '../evidence/contract.js';

export interface TerminalContext {
  mode: 'pipe' | 'pty';
  modeEvidence: 'captured' | 'declared';
  rows?: number;
  columns?: number;
  color: boolean;
  glyphs: 'unicode' | 'ascii';
  term?: string;
  locale?: string;
}

export interface RedactionManifestEntry {
  location: 'argv' | 'environment' | 'stdout' | 'stderr' | 'pty' | 'keystroke';
  classification: 'sensitive-flag' | 'sensitive-environment' | 'explicit-secret' | 'secret-keystroke';
  count: number;
}

export interface SanitizedKeystroke {
  sequence: number;
  atMilliseconds?: number;
  key?: string;
  text?: string;
  secretEntry: boolean;
}

export interface TerminalGeneratedArtifact {
  id: string;
  kind: 'file' | 'url';
  locator: string;
  mediaType: string;
  digest: Sha256Digest;
  sizeBytes: number;
}

export interface JsonOutcome {
  /** Exact persisted stdout bytes decoded as UTF-8; may be redacted as declared. */
  exactStdout: string;
  redacted: boolean;
  parsed: boolean;
  schema: 'valid' | 'invalid' | 'not_checked';
  error?: string;
}

export interface OrderedTerminalEvent {
  sequence: number;
  stream: 'pty';
  text: string;
  atMilliseconds?: number;
}

export interface TerminalOutcome {
  kind: 'exit' | 'signal' | 'timeout' | 'spawn_error';
  exitCode?: number;
  signal?: string;
  spawnError?: { code?: string; message: string };
  startedAt: string;
  completedAt: string;
  timeSource: 'captured' | 'import_inferred';
  durationMilliseconds: number;
  encoding: 'utf-8';
  streams: 'separate' | 'pty_merged';
  stdout?: string;
  stderr?: string;
  events?: OrderedTerminalEvent[];
  json?: JsonOutcome;
  suppressedSecretKeystrokes?: number;
}

export interface TerminalObservation {
  schemaVersion: '1.0.0';
  id: string;
  scenarioId: string;
  runner: string;
  command: {
    /** Already-redacted structured arguments. Never a reconstructed shell command. */
    argv: string[];
    cwd: string;
  };
  environment: {
    allowlisted?: Record<string, string>;
    digest: `sha256:${string}`;
  };
  source: SourceIdentity;
  runtime: {
    name: string;
    version?: string;
    toolVersions?: Record<string, string>;
    configurationIdentity?: string;
  };
  terminal: TerminalContext;
  outcome: TerminalOutcome;
  status: string;
  detail?: string;
  residualSecretScan: { passed: boolean; findings: string[] };
  redactionManifest: RedactionManifestEntry[];
  keystrokes: SanitizedKeystroke[];
  generatedArtifacts: TerminalGeneratedArtifact[];
  replay: {
    argvKnown: boolean;
    cwdKnown: boolean;
    environmentKnown: boolean;
    terminalKnown: boolean;
    inputs: Record<string, JsonValue>;
    nonclaims: string[];
  };
}

export interface PortableTerminalBundle {
  format: 'proofshot-terminal-bundle';
  version: '1.0.0';
  observations: TerminalObservation[];
  proof: ProofBundle;
}
