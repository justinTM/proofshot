import type { BrowserEventObservation, BrowserImportContext, BrowserImportResult, BrowserObservation } from './evidence.js';
import { browserProofBoundary, deriveCaptureHealth, detectBrowserProvenanceDrift, validateBrowserImportContext } from './evidence.js';
import { redactBrowserAction, redactBrowserValue, redactKnownBrowserSecrets } from './redact.js';

interface TraceEvent { type?: string; time?: string; [key: string]: unknown }
const ARTIFACT_KINDS = new Set(['screenshot', 'video', 'dom', 'accessibility', 'focus', 'keyboard', 'clipboard']);
const CAPTURE_KINDS = new Set([...ARTIFACT_KINDS, 'console', 'network']);

/** Imports dependency-free JSON/JSONL trace-style fixtures; it never loads Playwright. */
export function importPlaywrightTraceFixture(
  input: string | TraceEvent[],
  context: BrowserImportContext,
): BrowserImportResult {
  validateBrowserImportContext(context);
  const parsed = Array.isArray(input)
    ? input
    : input.trim().startsWith('[')
      ? JSON.parse(input)
      : input.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const rawEvents = parsed as TraceEvent[];
  const rawAction = rawEvents.find(({ type }) => type === 'action');
  const redactedAction = redactBrowserAction(
    (String(rawAction?.name ?? '').match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((token) =>
      token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token,
    ),
  );
  const events = redactKnownBrowserSecrets(
    redactBrowserValue(rawEvents),
    redactedAction.secretValues,
  ) as TraceEvent[];
  const warnings: string[] = [];
  const capture = events.filter(({ type }, index) => {
    if (type !== 'capture') return false;
    if (!CAPTURE_KINDS.has(String(events[index].kind ?? ''))) {
      warnings.push(`Trace capture ${index} has an unsupported kind; it was omitted`);
      return false;
    }
    return true;
  });
  const action = events.find(({ type }) => type === 'action');
  const targetEvents: BrowserEventObservation[] = events
    .filter(({ type }) => type === 'console' || type === 'network')
    .map((event) => ({ ...(event as object), kind: event.type as 'console' | 'network', health: 'observed' }));
  const health = (kind: string) => deriveCaptureHealth(
    capture.some((item) => item.kind === kind),
    capture.some((item) => item.kind === kind && item.status !== 'completed'),
  );
  const observation: BrowserObservation = {
    id: 'playwright-trace-1',
    observedAt: String(events.at(-1)?.time ?? events[0]?.time ?? new Date(0).toISOString()),
    target: context.target,
    proofBoundary: browserProofBoundary(context.target),
    source: context.source,
    runtime: context.runtime,
    artifacts: capture.filter((item) => ARTIFACT_KINDS.has(String(item.kind))).map((item) => ({
      kind: item.kind as BrowserObservation['artifacts'][number]['kind'],
      health: item.status === 'completed' ? 'observed' : 'blocked',
      uri: typeof item.uri === 'string' ? item.uri : undefined,
      value: item.value as never,
      reason: typeof item.reason === 'string' ? item.reason : undefined,
      redacted: true,
    })),
    events: targetEvents,
    interaction: action ? {
      action: redactedAction.action || 'trace action',
      status: action.status === 'completed' && (action.exitCode === undefined || action.exitCode === 0)
        ? 'completed'
        : action.status === 'timed_out'
          ? 'timed_out'
          : 'failed',
      startedAt: typeof action.startTime === 'string' ? action.startTime : undefined,
      completedAt: typeof action.time === 'string' ? action.time : undefined,
      exitCode: typeof action.exitCode === 'number' ? action.exitCode : undefined,
    } : undefined,
    captureHealth: {
      screenshot: health('screenshot'), video: health('video'), dom: health('dom'),
      accessibility: health('accessibility'), focus: health('focus'), keyboard: health('keyboard'),
      clipboard: health('clipboard'), console: health('console'), network: health('network'),
    },
    provenanceDrift: detectBrowserProvenanceDrift(context.target, context.source),
  };
  if (!action) warnings.push('Trace has no completed action outcome; it is not treated as interaction success');
  return { adapter: { namespace: 'io.proofshot.playwright-trace-import', version: '1.0.0' }, observations: [observation], warnings };
}
