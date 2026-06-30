import { Command } from 'commander';
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

export function createCLI(): Command {
  const program = new Command();

  program
    .name('proofshot')
    .description('Visual verification for AI coding agents')
    .version(PROOFSHOT_VERSION);

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
    .option('--force', 'Override a stale session without running stop first')
    .action(async (options) => {
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
