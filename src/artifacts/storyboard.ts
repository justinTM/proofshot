import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import { findExecutablePath } from '../utils/process.js';

interface StoryboardOptions {
  inputDir: string;
  outputPath?: string;
  threshold?: number;
  grid?: string;
  width?: number;
}

const DEFAULT_THRESHOLD = 0.3;
const DEFAULT_GRID = '4x5';
const DEFAULT_WIDTH = 1600;
const MIN_SCENES_FOR_SCENE_MODE = 4;
const MAX_SCENES = 20;

function parseSceneTimes(text: string): number[] {
  const seen = new Set<string>();
  const times: number[] = [];
  for (const match of text.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0) continue;
    const time = Math.round(value * 10) / 10;
    const key = time.toFixed(1);
    if (seen.has(key)) continue;
    seen.add(key);
    times.push(time);
    if (times.length >= MAX_SCENES) break;
  }
  return times;
}

function scenesFromTimes(times: number[]) {
  return times.map((timeSec, i) => ({ label: `scene-${String(i + 1).padStart(3, '0')}`, timeSec }));
}

function sampledFramesFromDuration(durationSec: number): { label: string; timeSec: number }[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];

  return Array.from({ length: MAX_SCENES }, (_, i) => ({
    label: `sample-${String(i + 1).padStart(3, '0')}`,
    timeSec: Number(((durationSec * (i + 0.5)) / MAX_SCENES).toFixed(1)),
  }));
}

function runFfmpeg(ffmpeg: string, args: string[]): string {
  const result = spawnSync(ffmpeg, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(output || `Command failed: ${ffmpeg}`);
  return output;
}

function renderFilter(
  threshold: number,
  grid: string,
  width: number,
  options: { useSceneSelect: boolean; fps?: number | null },
): string {
  const cols = Number.parseInt(grid, 10) || 4;
  const thumbWidth = Math.max(1, Math.floor(width / cols));
  const fpsPrefix = options.fps ? `fps=${options.fps},` : '';
  const prefix = options.useSceneSelect ? `select='gt(scene\\,${threshold})',` : fpsPrefix;
  return `${prefix}scale=${thumbWidth}:-1:flags=lanczos,tile=${grid}`;
}

function readVideoDuration(ffprobe: string, videoPath: string): number | null {
  try {
    const output = runFfmpeg(ffprobe, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ]).trim();
    const duration = Number(output.split(/\r?\n/)[0]);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

export function generateStoryboardArtifact(options: StoryboardOptions): {
  imagePath: string | null;
  jsonPath: string | null;
} {
  const ffmpeg = findExecutablePath('ffmpeg');
  if (!ffmpeg) {
    console.log(chalk.dim('Storyboard unavailable: install ffmpeg to generate storyboard artifacts.'));
    return { imagePath: null, jsonPath: null };
  }
  const ffprobe = findExecutablePath('ffprobe');

  const inputDir = path.resolve(options.inputDir);
  const videoPath = ['session.webm', 'session.mp4', 'session.mov']
    .map((name) => path.join(inputDir, name))
    .find((candidate) => fs.existsSync(candidate));

  if (!videoPath) throw new Error(`No session video found in ${inputDir}`);

  const outputPath = path.resolve(options.outputPath || path.join(inputDir, 'storyboard.png'));
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const grid = options.grid ?? DEFAULT_GRID;
  const width = options.width ?? DEFAULT_WIDTH;
  const sceneOutput = runFfmpeg(ffmpeg, ['-hide_banner', '-i', videoPath, '-vf', `select='gt(scene\\,${threshold})',showinfo`, '-an', '-f', 'null', '-']);
  let scenes = scenesFromTimes(parseSceneTimes(sceneOutput));
  let mode: 'scene' | 'fallback' = scenes.length >= MIN_SCENES_FOR_SCENE_MODE ? 'scene' : 'fallback';
  const durationSec = mode === 'fallback' && ffprobe ? readVideoDuration(ffprobe, videoPath) : null;
  if (mode === 'fallback' && durationSec) {
    scenes = sampledFramesFromDuration(durationSec);
  }

  const artifactPath = path.join(inputDir, 'storyboard-scenes.json');
  const writeArtifact = (): void => {
    fs.writeFileSync(
      artifactPath,
      JSON.stringify(
        {
          videoPath: path.basename(videoPath),
          mode,
          scenes,
          threshold,
          grid,
          width,
          source: 'ffmpeg',
        },
        null,
        2,
      ) + '\n',
    );
  };

  const render = (useSceneSelect: boolean): void => {
    runFfmpeg(ffmpeg, [
      '-hide_banner',
      '-i',
      videoPath,
      '-vf',
      renderFilter(threshold, grid, width, {
        useSceneSelect,
        fps: !useSceneSelect && durationSec ? Number((MAX_SCENES / durationSec).toFixed(3)) : null,
      }),
      '-frames:v',
      '1',
      outputPath,
    ]);
  };

  if (mode === 'scene') {
    render(true);
  } else {
    render(false);
  }

  if (mode === 'fallback') {
    console.log(chalk.dim('Storyboard fallback: no scene cuts detected; using a plain tile sheet.'));
  }

  writeArtifact();
  return { imagePath: outputPath, jsonPath: artifactPath };
}
