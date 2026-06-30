import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findExecutablePathMock, spawnSyncMock } = vi.hoisted(() => ({
  findExecutablePathMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock('../utils/process.js', () => ({
  findExecutablePath: findExecutablePathMock,
}));

vi.mock('child_process', () => ({
  spawnSync: spawnSyncMock,
}));

import { generateStoryboardArtifact } from './storyboard.js';

describe('generateStoryboardArtifact', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    findExecutablePathMock.mockImplementation((command: string) =>
      command === 'ffprobe' ? '/usr/bin/ffprobe' : '/usr/bin/ffmpeg',
    );
    spawnSyncMock.mockReset();
  });

  function makeSessionDir(name: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `proofshot-${name}-`));
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'session.webm'), '');
    return sessionDir;
  }

  it('writes real scene timestamps when ffmpeg reports cuts', () => {
    const sessionDir = makeSessionDir('storyboard-scene');
    const outputPath = path.join(sessionDir, 'storyboard.png');

    spawnSyncMock.mockImplementation((file: string, args: string[]) => {
      if (args.some((arg) => arg.includes('showinfo'))) {
        return {
          stdout: '',
          stderr:
            '[Parsed_showinfo_0 @ 0x0] n: 1 pts: 100 pts_time:1.0 pos:0\n' +
            '[Parsed_showinfo_0 @ 0x0] n: 2 pts: 234 pts_time:2.3 pos:0\n' +
            '[Parsed_showinfo_0 @ 0x0] n: 3 pts: 345 pts_time:3.4 pos:0\n' +
            '[Parsed_showinfo_0 @ 0x0] n: 4 pts: 456 pts_time:4.6 pos:0\n',
          status: 0,
          error: undefined,
        } as never;
      }

      fs.writeFileSync(outputPath, 'png');
      return { stdout: '', stderr: '', status: 0, error: undefined } as never;
    });

    const result = generateStoryboardArtifact({ inputDir: sessionDir, outputPath });
    const storyboard = JSON.parse(fs.readFileSync(path.join(sessionDir, 'storyboard-scenes.json'), 'utf8'));

    expect(result.imagePath).toBe(outputPath);
    expect(storyboard.mode).toBe('scene');
    expect(storyboard.scenes).toEqual([
      { label: 'scene-001', timeSec: 1 },
      { label: 'scene-002', timeSec: 2.3 },
      { label: 'scene-003', timeSec: 3.4 },
      { label: 'scene-004', timeSec: 4.6 },
    ]);
    expect(spawnSyncMock.mock.calls[0][1].join(' ')).toContain('showinfo');
    expect(spawnSyncMock.mock.calls[1][1].join(' ')).toContain("select='gt(scene");
  });

  it('falls back immediately when no scenes are detected', () => {
    const sessionDir = makeSessionDir('storyboard-fallback');
    const outputPath = path.join(sessionDir, 'storyboard.png');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    spawnSyncMock.mockImplementation((file: string, args: string[]) => {
      if (args.some((arg) => arg.includes('showinfo'))) {
        return { stdout: '', stderr: '', status: 0, error: undefined } as never;
      }

      if (args.includes('-show_entries')) {
        return { stdout: '40.0\n', stderr: '', status: 0, error: undefined } as never;
      }

      fs.writeFileSync(outputPath, 'png');
      return { stdout: '', stderr: '', status: 0, error: undefined } as never;
    });

    generateStoryboardArtifact({ inputDir: sessionDir, outputPath });
    const storyboard = JSON.parse(fs.readFileSync(path.join(sessionDir, 'storyboard-scenes.json'), 'utf8'));

    expect(storyboard.mode).toBe('fallback');
    expect(storyboard.scenes).toHaveLength(20);
    expect(storyboard.scenes[0]).toEqual({ label: 'sample-001', timeSec: 1 });
    expect(storyboard.scenes[19]).toEqual({ label: 'sample-020', timeSec: 39 });
    expect(spawnSyncMock.mock.calls).toHaveLength(3);
    expect(spawnSyncMock.mock.calls[2][1].join(' ')).toContain('fps=0.5');
    expect(spawnSyncMock.mock.calls[2][1].join(' ')).not.toContain('select=gt(scene');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Storyboard fallback');
  });

  it('skips cleanly when ffmpeg is unavailable', () => {
    findExecutablePathMock.mockReturnValue(null);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = generateStoryboardArtifact({ inputDir: '/tmp/does-not-matter' });

    expect(result).toEqual({ imagePath: null, jsonPath: null });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Storyboard unavailable');
  });
});
