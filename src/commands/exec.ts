import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { loadConfig } from '../utils/config.js';
import { ab, buildAgentBrowserCommand, setAgentBrowserDefaults } from '../utils/exec.js';
import { loadSession, saveSession, type SessionState } from '../session/state.js';
import { redactBrowserAction, redactBrowserText } from '../browser/redact.js';

const SESSION_LOG_FILENAME = 'session-log.json';

export interface SessionLogEntry {
  action: string;
  relativeTimeSec: number;
  timestamp: string;
  element?: {
    label: string;
    bbox: { x: number; y: number; width: number; height: number };
    viewport: { width: number; height: number };
  };
  structuredAction?: { command: string; args: string[]; redacted: boolean };
  precondition?: { sessionActive: boolean; element?: SessionLogEntry['element'] };
  attemptedAction?: { status: 'attempted'; at: string };
  outcome?: {
    status: 'completed' | 'failed' | 'timed_out';
    startedAt: string;
    completedAt: string;
    durationMs: number;
    exitCode: number | null;
    signal: string | null;
    timeout: boolean;
    stdout: string;
    stderr: string;
  };
  postcondition?: { commandCompleted: boolean; screenshotExists?: boolean };
}

/**
 * Load existing session log entries from disk.
 */
export function loadSessionLog(sessionDir: string): SessionLogEntry[] {
  const logPath = path.join(sessionDir, SESSION_LOG_FILENAME);
  if (!fs.existsSync(logPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(logPath, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * For screenshot commands, resolve relative paths into the session directory
 * so agents can just say `proofshot exec screenshot step-name.png`.
 */
function resolveScreenshotPath(args: string[], sessionDir: string): string[] {
  if (args[0] !== 'screenshot' || args.length < 2) return args;

  const screenshotPath = args[args.length - 1];
  // If it's already absolute, leave it alone
  if (path.isAbsolute(screenshotPath)) return args;

  // Resolve relative to session dir
  const resolved = path.join(sessionDir, screenshotPath);
  return [...args.slice(0, -1), resolved];
}

/**
 * Build the shell command string for agent-browser.
 *
 * For `eval` commands, we need to pass the JS code as a single quoted argument
 * to prevent the shell from interpreting parentheses, brackets, etc.
 * For other commands, simple joining is fine.
 */
export function buildShellCommand(args: string[], sessionName?: string): string {
  if (args[0] === 'eval' && args.length > 1) {
    const jsCode = args.slice(1).join(' ');
    const escaped = jsCode.replace(/'/g, "'\\''");
    return buildAgentBrowserCommand(`eval '${escaped}'`, { session: sessionName });
  }

  const quotedArgs = args.map((arg) => {
    if (/[(){}[\]$`!#&|;<>*? "'\\]/.test(arg)) {
      const escaped = arg.replace(/'/g, "'\\''");
      return `'${escaped}'`;
    }
    return arg;
  });
  return buildAgentBrowserCommand(quotedArgs.join(' '), { session: sessionName });
}

/**
 * Parse an element ref (@eN) from command args.
 */
function parseElementRef(args: string[]): string | null {
  for (const arg of args) {
    const match = arg.match(/@e\d+/);
    if (match) return match[0];
  }
  return null;
}

/**
 * Capture element bounding box and label before action execution.
 *
 * agent-browser's `get box` doesn't support @eN refs, but `get text` and
 * `get attr` do. Strategy:
 * 1. Try `get attr @eN id` — if found, use `get box #<id>` (reliable for inputs)
 * 2. Otherwise try `get text @eN` — use `get box "text=<label>"` (works for links/buttons)
 * 3. Label comes from get text (links/buttons) or get attr fallback chain (inputs)
 *
 * None of these commands invalidate snapshot refs, so the subsequent action still works.
 */
function captureElementData(
  ref: string,
  viewport: { width: number; height: number },
  sessionName?: string,
): SessionLogEntry['element'] | null {
  try {
    let bbox: { x: number; y: number; width: number; height: number } | null = null;
    let label = '';

    // Strategy 1: Try id-based selector (works for inputs with id attributes)
    let elemId = '';
    try { elemId = ab(`get attr ${ref} id`, { session: sessionName }); } catch { /* empty */ }

    if (elemId) {
      try {
        const raw = ab(`get box '#${elemId}'`, { session: sessionName });
        bbox = JSON.parse(raw);
      } catch { /* empty */ }

      // For inputs, get label from associated <label> via eval (doesn't invalidate refs)
      try {
        const raw = ab(
          `eval "document.getElementById('${elemId}')?.labels?.[0]?.textContent||document.getElementById('${elemId}')?.placeholder||document.getElementById('${elemId}')?.getAttribute('aria-label')||''"`,
          { session: sessionName },
        );
        label = JSON.parse(raw) || '';
      } catch { /* empty */ }
    }

    // Strategy 2: Try text-based selector (works for links, buttons)
    if (!bbox) {
      try { label = ab(`get text ${ref}`, { session: sessionName }); } catch { /* empty */ }
      if (!label) {
        try { label = ab(`get attr ${ref} placeholder`, { session: sessionName }); } catch { /* empty */ }
      }
      if (!label) {
        try { label = ab(`get attr ${ref} aria-label`, { session: sessionName }); } catch { /* empty */ }
      }
      if (!label) {
        try { label = ab(`get attr ${ref} name`, { session: sessionName }); } catch { /* empty */ }
      }

      if (label) {
        try {
          const escaped = label.replace(/'/g, "\\'");
          const raw = ab(`get box 'text=${escaped}'`, { session: sessionName });
          bbox = JSON.parse(raw);
        } catch { /* empty */ }
      }
    }

    if (!bbox) return null;

    return {
      label: label || '',
      bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
      viewport,
    };
  } catch {
    return null;
  }
}

/**
 * Check if the action is ref-targeted (click, fill, type with @eN).
 */
function isRefTargetedAction(args: string[]): boolean {
  const cmd = args[0]?.toLowerCase();
  return (cmd === 'click' || cmd === 'fill' || cmd === 'type') && parseElementRef(args) !== null;
}

/**
 * proofshot exec <agent-browser-args...>
 *
 * 1. Read session state to get sessionDir and startedAt
 * 2. For screenshot commands, resolve paths into the session dir
 * 3. For ref-targeted actions, capture element bbox + label BEFORE execution
 * 4. Execute the action and capture its completed process outcome
 * 5. Redact and append precondition/action/outcome/postcondition to session-log.json
 * 6. Pass output through and preserve failure exit status
 * 7. If action was `set viewport`, update cached viewport in session state
 */
export async function execCommand(args: string[], run = spawnSync): Promise<void> {
  const redactedAction = redactBrowserAction(args);
  const action = redactedAction.action;

  // Load session state
  const config = loadConfig();
  setAgentBrowserDefaults({ configPath: config.browser.configPath });
  const outputDir = path.resolve(config.output);
  const session = loadSession(outputDir);

  if (session && !session.recordingActive && session.videoEnabled !== false) {
    console.error(
      'Error: Session has no active recording. Video capture is required.\n' +
        'Run "proofshot stop" to end this session, then start a new one.',
    );
    process.exit(1);
  }

  // Resolve args (screenshot path rewriting)
  let resolvedArgs = args;
  if (session) {
    resolvedArgs = resolveScreenshotPath(args, session.sessionDir);
  }

  // Capture element data BEFORE execution (element may be gone after click navigation)
  let elementData: SessionLogEntry['element'] | undefined;
  if (session && isRefTargetedAction(args)) {
    const ref = parseElementRef(args)!;
    const viewport = session.viewport || { width: 1280, height: 720 };
    const captured = captureElementData(ref, viewport, session.sessionName);
    if (captured) elementData = captured;
  }

  // Build shell command with proper quoting
  const shellCmd = buildShellCommand(resolvedArgs, session?.sessionName);
  const startedAt = new Date();
  const result = run(shellCmd, {
    encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'], shell: true,
  });
  const completedAt = new Date();
  const rawStdout = result.stdout?.toString() ?? '';
  const rawStderr = result.stderr?.toString() ?? '';
  const stdout = redactedAction.redactOutput && rawStdout
    ? '[REDACTED]'
    : redactBrowserText(rawStdout, redactedAction.secretValues);
  const stderr = redactedAction.redactOutput && rawStderr
    ? '[REDACTED]'
    : redactBrowserText(rawStderr, redactedAction.secretValues);
  const timedOut = result.error != null && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const succeeded = result.status === 0 && !result.error;

  if (session) {
    const entry: SessionLogEntry = {
      action,
      relativeTimeSec: parseFloat(((startedAt.getTime() - new Date(session.startedAt).getTime()) / 1000).toFixed(1)),
      timestamp: startedAt.toISOString(),
      structuredAction: {
        command: redactedAction.args[0] ?? '',
        args: redactedAction.args.slice(1),
        redacted: redactedAction.secretValues.length > 0 || redactedAction.redactOutput,
      },
      precondition: { sessionActive: true, ...(elementData ? { element: elementData } : {}) },
      attemptedAction: { status: 'attempted', at: startedAt.toISOString() },
      outcome: {
        status: timedOut ? 'timed_out' : succeeded ? 'completed' : 'failed',
        startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(), exitCode: result.status,
        signal: result.signal, timeout: timedOut, stdout, stderr,
      },
      postcondition: {
        commandCompleted: succeeded,
        ...(args[0] === 'screenshot' ? { screenshotExists: succeeded && fs.existsSync(resolvedArgs.at(-1) ?? '') } : {}),
      },
      ...(elementData ? { element: elementData } : {}),
    };
    const logPath = path.join(session.sessionDir, SESSION_LOG_FILENAME);
    fs.writeFileSync(logPath, JSON.stringify([...loadSessionLog(session.sessionDir), entry], null, 2) + '\n');
  }
  if (stdout) process.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`);
  if (stderr) process.stderr.write(stderr);
  if (!succeeded) process.exit(result.status ?? 1);

  // If the action was `set viewport`, update cached viewport in session state
  if (session && args[0] === 'set' && args[1] === 'viewport') {
    try {
      const vpJson = ab("eval 'JSON.stringify({width: window.innerWidth, height: window.innerHeight})'", {
        session: session.sessionName,
      });
      const vp = JSON.parse(vpJson);
      session.viewport = { width: vp.width, height: vp.height };
      saveSession(session);
    } catch {
      // Non-critical — viewport cache stays stale
    }
  }
}
