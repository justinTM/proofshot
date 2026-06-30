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

function renderFilter(threshold: number, grid: string, width: number, useSceneSelect: boolean): string {
  const cols = Number.parseInt(grid, 10) || 4;
  const thumbWidth = Math.max(1, Math.floor(width / cols));
  const prefix = useSceneSelect ? `select='gt(scene\\,${threshold})',` : '';
  return `${prefix}scale=${thumbWidth}:-1:flags=lanczos,tile=${grid}`;
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
  const scenes = scenesFromTimes(parseSceneTimes(sceneOutput));
  let mode: 'scene' | 'fallback' = scenes.length >= MIN_SCENES_FOR_SCENE_MODE ? 'scene' : 'fallback';

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
    runFfmpeg(ffmpeg, ['-hide_banner', '-i', videoPath, '-vf', renderFilter(threshold, grid, width, useSceneSelect), '-frames:v', '1', outputPath]);
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
