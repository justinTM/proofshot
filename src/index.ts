// Public API
export { createCLI } from './cli.js';
export { installCommand } from './commands/install.js';
export { ensureDevServer } from './server/start.js';
export { loadConfig, writeConfig, type ProofShotConfig } from './utils/config.js';
export { ab, ProofShotError } from './utils/exec.js';
export { isPortOpen, waitForPort } from './utils/port.js';
export { saveSession, loadSession, type SessionState } from './session/state.js';
export { writeViewer, generateViewer } from './artifacts/viewer.js';
export type { SessionLogEntry } from './commands/exec.js';
export { writeMetadata, loadMetadata, findSessionsForBranch, type SessionMetadata } from './session/metadata.js';
export { formatPRComment, type PRCommentData } from './artifacts/pr-format.js';
export * from './evidence/contract.js';
export { compileProofBundle, sha256Digest, validateProofBundle } from './evidence/validate.js';
export { captureSourceIdentity } from './evidence/source.js';
export {
  captureTerminal,
  type CaptureTerminalOptions,
  type GeneratedArtifactInput,
} from './terminal/adapter.js';
export {
  importOdoCliMatrix,
  type DeclaredTerminalContext,
  type ImportedGeneratedArtifact,
  type ImportedKeystroke,
  type ImportOdoOptions,
  type OdoRunResult,
} from './terminal/import-odo.js';
export {
  redactArgv,
  redactArgvWithManifest,
  redactEnvironment,
  redactText,
  redactTextDetailed,
  scanResidualSecrets,
  type RedactionPolicy,
} from './terminal/redact.js';
export * from './terminal/types.js';
export * from './browser/evidence.js';
export { redactBrowserAction, redactBrowserText, redactBrowserUrl, redactBrowserValue, redactKnownBrowserSecrets } from './browser/redact.js';
export { importAgentBrowserSession } from './browser/import-agent-browser.js';
export { importPlaywrightTraceFixture } from './browser/import-playwright-trace.js';
