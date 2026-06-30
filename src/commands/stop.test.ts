import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  loadSession: vi.fn(),
  stopRecording: vi.fn(),
  closeBrowser: vi.fn(),
  getConsoleErrors: vi.fn(),
  getConsoleOutput: vi.fn(),
  getConsoleOutputJson: vi.fn(),
  writeViewer: vi.fn(),
  extractServerErrors: vi.fn(),
  loadSessionLog: vi.fn(),
  estimateTokenUsage: vi.fn(),
  generateStoryboardArtifact: vi.fn(),
}));

vi.mock('../utils/config.js', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('../session/state.js', () => ({ loadSession: mocks.loadSession, clearSession: vi.fn() }));
vi.mock('../browser/capture.js', () => ({ stopRecording: mocks.stopRecording }));
vi.mock('../browser/session.js', () => ({
  closeBrowser: mocks.closeBrowser,
  getConsoleErrors: mocks.getConsoleErrors,
  getConsoleOutput: mocks.getConsoleOutput,
  getConsoleOutputJson: mocks.getConsoleOutputJson,
}));
vi.mock('../artifacts/viewer.js', () => ({ writeViewer: mocks.writeViewer }));
vi.mock('../utils/error-patterns.js', () => ({ extractServerErrors: mocks.extractServerErrors }));
vi.mock('../commands/exec.js', () => ({ loadSessionLog: mocks.loadSessionLog }));
vi.mock('../utils/token-usage.js', () => ({ estimateTokenUsage: mocks.estimateTokenUsage }));
vi.mock('../artifacts/storyboard.js', () => ({ generateStoryboardArtifact: mocks.generateStoryboardArtifact }));

import { stopCommand } from './stop.js';

describe('stopCommand storyboard mode', () => {
  const root = '/tmp/proofshot-stop';
  const sessionDir = path.join(root, 'session');

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    mocks.loadConfig.mockReturnValue({ output: root, browser: { configPath: null } });
    mocks.loadSession.mockReturnValue({
      startedAt: '2026-04-14T00:00:00.000Z',
      sessionDir,
      sessionName: 'proofshot-test',
      recordingActive: false,
      videoPath: path.join(sessionDir, 'session.webm'),
      serverErrorLog: path.join(sessionDir, 'server.log'),
      serverCommand: 'npm run dev',
      port: 3000,
      description: 'storyboard test',
      viewport: { width: 1280, height: 720 },
    });
    mocks.getConsoleErrors.mockReturnValue('No errors');
    mocks.getConsoleOutput.mockReturnValue('');
    mocks.getConsoleOutputJson.mockReturnValue([]);
    mocks.writeViewer.mockReturnValue(path.join(sessionDir, 'viewer.html'));
    mocks.extractServerErrors.mockReturnValue([]);
    mocks.loadSessionLog.mockReturnValue([]);
    mocks.estimateTokenUsage.mockReturnValue(null);
    mocks.stopRecording.mockImplementation(() => {});
    mocks.closeBrowser.mockImplementation(() => {});
    mocks.generateStoryboardArtifact.mockReturnValue({
      imagePath: path.join(sessionDir, 'storyboard.png'),
      jsonPath: path.join(sessionDir, 'storyboard-scenes.json'),
    });
  });

  it('keeps storyboard generation opt-in', async () => {
    await stopCommand({ noClose: true, storyboard: true });
    expect(mocks.generateStoryboardArtifact).toHaveBeenCalledWith({ inputDir: sessionDir });

    mocks.generateStoryboardArtifact.mockClear();
    await stopCommand({ noClose: true });
    expect(mocks.generateStoryboardArtifact).not.toHaveBeenCalled();
  });
});
