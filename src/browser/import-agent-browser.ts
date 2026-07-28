import type { JsonValue } from '../evidence/contract.js';
import {
  deriveCaptureHealth,
  detectBrowserProvenanceDrift,
  browserProofBoundary,
  type BrowserArtifactObservation,
  type BrowserImportContext,
  type BrowserImportResult,
  type BrowserEventObservation,
  type BrowserObservation,
  validateBrowserImportContext,
} from './evidence.js';
import { redactBrowserAction, redactBrowserValue, redactKnownBrowserSecrets } from './redact.js';

interface AgentBrowserEntry {
  timestamp?: string;
  action?: string;
  structuredAction?: { command?: string; args?: string[] };
  precondition?: unknown;
  postcondition?: unknown;
  outcome?: {
    status?: string;
    exitCode?: number | null;
    signal?: string | null;
    timeout?: boolean;
    stdout?: string;
    stderr?: string;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
  };
  artifacts?: unknown[];
  console?: unknown[];
  network?: unknown[];
  capture?: Record<string, unknown>;
}

function parseInput(input: string | unknown): AgentBrowserEntry[] {
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  if (Array.isArray(value)) return value as AgentBrowserEntry[];
  if (value && typeof value === 'object' && Array.isArray((value as { entries?: unknown[] }).entries)) {
    return (value as { entries: AgentBrowserEntry[] }).entries;
  }
  throw new Error('Agent-browser session log must be an array or an object with entries');
}

const ARTIFACT_KINDS = new Set(['screenshot', 'video', 'dom', 'accessibility', 'focus', 'keyboard', 'clipboard']);

function artifactHealth(
  artifacts: BrowserArtifactObservation[],
  kind: BrowserArtifactObservation['kind'],
) {
  const matching = artifacts.filter((artifact) => artifact.kind === kind);
  if (matching.some(({ health }) => health === 'blocked')) return 'blocked' as const;
  if (matching.some(({ health }) => health === 'observed')) return 'observed' as const;
  return 'not_observed' as const;
}

function actionArgs(entry: AgentBrowserEntry): string[] {
  if (entry.structuredAction?.command) {
    return [entry.structuredAction.command, ...(entry.structuredAction.args ?? [])];
  }
  return (entry.action?.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((token) =>
    token.startsWith('"') && token.endsWith('"')
      ? token.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      : token,
  );
}

function normalizeEvents(
  values: unknown[] | undefined,
  kind: BrowserEventObservation['kind'],
  entryIndex: number,
  warnings: string[],
): BrowserEventObservation[] {
  return (values ?? []).flatMap((event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      warnings.push(`Entry ${entryIndex} contains a malformed ${kind} event; it was omitted`);
      return [];
    }
    return [{ ...(event as object), kind, health: 'observed' as const }];
  });
}

export function importAgentBrowserSession(
  input: string | unknown,
  context: BrowserImportContext,
): BrowserImportResult {
  validateBrowserImportContext(context);
  const warnings: string[] = [];
  const entries = parseInput(input);
  const observations = entries.map((raw, index): BrowserObservation => {
    const redactedAction = redactBrowserAction(actionArgs(raw));
    const entry = redactKnownBrowserSecrets(
      redactBrowserValue(raw),
      redactedAction.secretValues,
    ) as AgentBrowserEntry;
    const action = redactedAction.action;
    const outcome = entry.outcome;
    const artifacts: BrowserArtifactObservation[] = [];
    for (const item of entry.artifacts ?? []) {
      if (!item || typeof item !== 'object') {
        warnings.push(`Entry ${index} contains a malformed artifact; it was omitted`);
        continue;
      }
      const artifact = item as BrowserArtifactObservation;
      if (!ARTIFACT_KINDS.has(artifact.kind) || !['observed', 'not_observed', 'blocked'].includes(artifact.health)) {
        warnings.push(`Entry ${index} contains an unsupported artifact; it was omitted`);
        continue;
      }
      artifacts.push(artifact);
    }
    if (entry.precondition !== undefined) artifacts.push({ kind: 'dom', health: 'observed', value: entry.precondition as JsonValue, redacted: true });
    if (entry.postcondition !== undefined) artifacts.push({ kind: 'dom', health: 'observed', value: entry.postcondition as JsonValue, redacted: true });
    const consoleAttempted = Array.isArray(entry.console) || entry.capture?.consoleAttempted === true;
    const networkAttempted = Array.isArray(entry.network) || entry.capture?.networkAttempted === true;
    const consoleFailed = entry.capture?.consoleFailed === true;
    const networkFailed = entry.capture?.networkFailed === true;
    const completed = outcome?.status === 'completed'
      && outcome.exitCode === 0
      && !outcome.signal
      && !outcome.timeout
      && Boolean(outcome.completedAt);
    if (!outcome || (outcome.status === 'completed' && !completed)) {
      warnings.push(`Entry ${index} has no trustworthy completed outcome; it is not treated as successful`);
    }
    return {
      id: `agent-browser-${index + 1}`,
      observedAt: outcome?.completedAt ?? entry.timestamp ?? new Date(0).toISOString(),
      target: context.target,
      proofBoundary: browserProofBoundary(context.target),
      source: context.source,
      runtime: context.runtime,
      artifacts,
      events: [
        ...normalizeEvents(entry.console, 'console', index, warnings),
        ...normalizeEvents(entry.network, 'network', index, warnings),
      ],
      interaction: action ? {
        action,
        status: !outcome
          ? 'not_observed'
          : outcome.timeout
            ? 'timed_out'
            : completed
              ? 'completed'
              : outcome.status === 'blocked'
                ? 'blocked'
                : outcome.status === 'completed'
                  ? 'not_observed'
                  : 'failed',
        startedAt: outcome?.startedAt,
        completedAt: outcome?.completedAt,
        exitCode: outcome?.exitCode,
        signal: outcome?.signal,
        timeout: outcome?.timeout,
        stdout: redactedAction.redactOutput && outcome?.stdout ? '[REDACTED]' : outcome?.stdout,
        stderr: redactedAction.redactOutput && outcome?.stderr ? '[REDACTED]' : outcome?.stderr,
        durationMs: outcome?.durationMs,
      } : undefined,
      captureHealth: {
        screenshot: artifactHealth(artifacts, 'screenshot'),
        video: artifactHealth(artifacts, 'video'),
        dom: artifactHealth(artifacts, 'dom'),
        accessibility: artifactHealth(artifacts, 'accessibility'),
        focus: artifactHealth(artifacts, 'focus'),
        keyboard: artifactHealth(artifacts, 'keyboard'),
        clipboard: artifactHealth(artifacts, 'clipboard'),
        console: deriveCaptureHealth(consoleAttempted, consoleFailed),
        network: deriveCaptureHealth(networkAttempted, networkFailed),
      },
      provenanceDrift: detectBrowserProvenanceDrift(context.target, context.source),
    };
  });
  return { adapter: { namespace: 'io.proofshot.agent-browser-import', version: '1.0.0' }, observations, warnings };
}
