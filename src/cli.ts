import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { installCommand } from './commands/install.js';
import { startCommand } from './commands/start.js';
import { stopCommand } from './commands/stop.js';
import { diffCommand } from './commands/diff.js';
import { cleanCommand } from './commands/clean.js';
import { prCommand } from './commands/pr.js';
import { execCommand } from './commands/exec.js';
import { doctorCommand } from './commands/doctor.js';
import { generateStoryboardArtifact } from './artifacts/storyboard.js';
import { PROOFSHOT_VERSION } from './version.js';
import { importOdoCliMatrix } from './terminal/import-odo.js';

export function createCLI(): Command {
  const program = new Command();

  program
    .name('proofshot')
    .description('Visual verification for AI coding agents')
    .version(PROOFSHOT_VERSION);

  program
    .command('import-odo')
    .description('Import completed ODO cli_matrix runs.jsonl as portable terminal evidence (video not required)')
    .requiredOption('--input <runs.jsonl>', 'ODO cli_matrix RunResult JSONL')
    .requiredOption('--output <directory>', 'Portable machine bundle output directory')
    .requiredOption('--cwd <directory>', 'Recorded scenario working directory')
    .option('--terminal-mode <mode>', 'Declared fallback terminal mode: pipe or pty')
    .option('--terminal-contexts <file>', 'JSON object keyed by runner, scenario, or runner:scenario')
    .option('--rows <number>', 'PTY rows', parseInt)
    .option('--columns <number>', 'Terminal columns', parseInt)
    .option('--color <mode>', 'Color behavior: auto, always, or never', 'auto')
    .option('--glyphs <mode>', 'Glyph behavior: unicode or ascii', 'unicode')
    .option('--artifacts <file>', 'JSON object mapping scenario IDs to generated file/URL captures')
    .option('--keystrokes <file>', 'JSON object mapping scenario IDs to sanitized keystroke inputs')
    .option('--env <name...>', 'Allowlisted environment names to record from the current process')
    .action(async (options) => {
      if (options.terminalMode && !['pipe', 'pty'].includes(options.terminalMode)) {
        throw new Error('--terminal-mode must be pipe or pty');
      }
      if (!options.terminalMode && !options.terminalContexts) {
        throw new Error('Declare --terminal-mode or provide --terminal-contexts');
      }
      if (!['auto', 'always', 'never'].includes(options.color)) {
        throw new Error('--color must be auto, always, or never');
      }
      if (!['unicode', 'ascii'].includes(options.glyphs)) {
        throw new Error('--glyphs must be unicode or ascii');
      }
      if ((options.rows !== undefined && (!Number.isInteger(options.rows) || options.rows <= 0))
        || (options.columns !== undefined && (!Number.isInteger(options.columns) || options.columns <= 0))) {
        throw new Error('--rows and --columns must be positive integers');
      }
      const readJson = async (file: string | undefined) => file
        ? JSON.parse(await readFile(file, 'utf8'))
        : undefined;
      const environment = Object.fromEntries(
        (options.env ?? []).flatMap((name: string) => process.env[name] === undefined ? [] : [[name, process.env[name] as string]]),
      );
      const result = await importOdoCliMatrix({
        input: options.input, outputDirectory: options.output, cwd: options.cwd,
        terminalMode: options.terminalMode,
        terminalContexts: await readJson(options.terminalContexts),
        rows: options.rows,
        columns: options.columns,
        color: options.color === 'auto' ? undefined : options.color === 'always',
        glyphs: options.glyphs,
        generatedArtifacts: await readJson(options.artifacts),
        keystrokes: await readJson(options.keystrokes),
        environment,
      });
      console.log(JSON.stringify({
        bundle: `${options.output}/bundle.json`,
        manifest: `${options.output}/manifest.json`,
        observations: result.observations.length,
      }));
    });

  program
    .command('install')
    .description('Install ProofShot skills at user level for all detected AI coding tools')
    .option('--only <tools>', 'Only install for these tools (comma-separated: claude,codex,cursor,gemini,windsurf,opencode)')
    .option('--skip <tools>', 'Skip these tools (comma-separated)')
    .option('--force', 'Overwrite existing skill files even if unchanged')
    .action(async (options) => {
      await installCommand(options);
    });

  program
    .command('start')
    .description('Start a verification session: browser, recording, error capture')
    .option('--description <text>', 'What is being verified (included in the proof report)')
    .option('--port <port>', 'Override detected port', parseInt)
    .option('--run <command>', 'Start this command and capture its logs')
    .option('--headed', 'Show browser window for debugging')
    .option('--output <dir>', 'Custom output directory')
    .option('--url <url>', 'Open this URL instead of the root')
    .option('--target-class <class>', 'Proof boundary: local or deployed_readonly')
    .option('--deployment-id <id>', 'Immutable deployed-target identity')
    .option('--build-id <id>', 'Immutable deployed build identity')
    .option('--source-revision <revision>', 'Source revision rendered by a deployed target')
    .option('--force', 'Override a stale session without running stop first')
    .option('--no-video', 'Collect browser, logs, and screenshots without recording video')
    .action(async (options) => {
      if (options.targetClass && !['local', 'deployed_readonly'].includes(options.targetClass)) {
        throw new Error('--target-class must be local or deployed_readonly');
      }
      await startCommand(options);
    });

  program
    .command('stop')
    .description('Stop session: stop recording, collect errors, bundle proof artifacts')
    .option('--no-close', 'Don\'t close the browser (keep it open for further use)')
    .option('--storyboard', 'Generate a storyboard contact sheet for the session video')
    .action(async (options) => {
      await stopCommand(options);
    });

  program
    .command('storyboard')
    .description('Generate a storyboard contact sheet from a completed session directory')
    .requiredOption('--input <dir>', 'Session directory containing session.webm')
    .option('--output <file>', 'Storyboard image output path')
    .option('--threshold <value>', 'FFmpeg scene-detection threshold', parseFloat)
    .option('--grid <cols>x<rows>', 'Storyboard grid size', '4x5')
    .option('--width <px>', 'Storyboard output width', parseInt)
    .action(async (options) => {
      try {
        const result = generateStoryboardArtifact({
          inputDir: options.input,
          outputPath: options.output,
          threshold: options.threshold,
          grid: options.grid,
          width: options.width,
        });

        if (!result.imagePath || !result.jsonPath) {
          console.log('Storyboard unavailable: install ffmpeg to generate it.');
          return;
        }

        console.log(`✓ Storyboard: ${result.imagePath}`);
        console.log(`✓ Scenes:     ${result.jsonPath}`);
      } catch (error: any) {
        console.error(`✗ Storyboard generation failed: ${error?.message || String(error)}`);
        process.exit(1);
      }
    });

  program
    .command('diff')
    .description('Compare current screenshots against a baseline')
    .requiredOption('--baseline <dir>', 'Directory with baseline screenshots')
    .action(async (options) => {
      await diffCommand(options);
    });

  program
    .command('clean')
    .description('Remove artifact files')
    .action(async () => {
      await cleanCommand();
    });

  program
    .command('doctor')
    .description('Inspect the local ProofShot environment and active session state')
    .action(async () => {
      await doctorCommand();
    });

  program
    .command('pr')
    .description('Upload session artifacts and post a ProofShot comment on a GitHub PR')
    .argument('[pr-number]', 'PR number (auto-detects from current branch if omitted)')
    .option('--dry-run', 'Generate the comment markdown without posting')
    .option(
      '--upload-provider <provider>',
      'Artifact upload backend: repo-contents or github-web-attachments',
      'repo-contents',
    )
    .option(
      '--artifacts-branch <branch>',
      'Git branch used by the repo-contents upload provider',
      'proofshot-artifacts',
    )
    .action(async (prNumber, options) => {
      await prCommand({ prNumber, ...options });
    });

  program
    .command('exec')
    .description('Run an agent-browser command with logging (use instead of agent-browser directly)')
    .argument('<args...>', 'agent-browser command and arguments')
    .allowUnknownOption()
    .action(async (args) => {
      await execCommand(args);
    });

  return program;
}
