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
  findExecutablePath: vi.fn(),
  runCommand: vi.fn(),
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
vi.mock('../utils/process.js', () => ({
  findExecutablePath: mocks.findExecutablePath,
  runCommand: mocks.runCommand,
}));

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
    fs.writeFileSync(path.join(sessionDir, 'session.webm'), 'webm');
    mocks.getConsoleErrors.mockReturnValue('No errors');
    mocks.getConsoleOutput.mockReturnValue('');
    mocks.getConsoleOutputJson.mockReturnValue([]);
    mocks.writeViewer.mockReturnValue(path.join(sessionDir, 'viewer.html'));
    mocks.extractServerErrors.mockReturnValue([]);
    mocks.loadSessionLog.mockReturnValue([]);
    mocks.estimateTokenUsage.mockReturnValue(null);
    mocks.stopRecording.mockImplementation(() => {});
    mocks.closeBrowser.mockImplementation(() => {});
    mocks.findExecutablePath.mockImplementation((command: string) =>
      command === 'ffmpeg' ? '/usr/bin/ffmpeg' : null,
    );
    mocks.runCommand.mockImplementation((command: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('libvpx-vp9')) return 'reencoded';
      if (joined.includes('-v error -i')) {
        if (joined.includes('libvpx-vp9')) return '';
        throw new Error('invalid webm');
      }
      return 'trimmed';
    });
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

  it('re-encodes the trim when the copy cut is invalid', async () => {
    const trimCalls: string[] = [];
    mocks.loadSessionLog.mockReturnValue([
      { relativeTimeSec: 8 },
      { relativeTimeSec: 19 },
    ]);
    mocks.runCommand.mockImplementation((command: string, args: string[]) => {
      const joined = args.join(' ');
      trimCalls.push(joined);
      if (joined.includes('-v error -i')) {
        if (trimCalls.some((call) => call.includes('libvpx-vp9'))) {
          return '';
        }
        throw new Error('invalid webm');
      }
      return 'ok';
    });

    await stopCommand({ noClose: true, storyboard: false });

    expect(trimCalls.some((call) => call.includes('-c copy'))).toBe(true);
    expect(trimCalls.some((call) => call.includes('libvpx-vp9'))).toBe(true);
  });
});
