import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ProofShotError } from './exec.js';

// ─── Types ───

export interface GitHubRepo {
  owner: string;
  repo: string;
  id: number;
  defaultBranch: string;
  isPrivate: boolean;
}

export interface UploadedAsset {
  url: string;
  name: string;
}

export interface UploadedVideoAsset extends UploadedAsset {
  renderMode: 'embed' | 'link';
}

export type GitHubUploadProvider = 'repo-contents' | 'github-web-attachments';

export interface UploadAssetsOptions {
  filePaths: string[];
  token: string;
  repo: GitHubRepo;
  uploadProvider: GitHubUploadProvider;
  uploadRoot: string;
  artifactsBranch?: string;
  onProgress?: (current: number, total: number, fileName: string) => void;
}

const GITHUB_API_VERSION = '2022-11-28';
const DEFAULT_ARTIFACTS_BRANCH = 'proofshot-artifacts';

// ─── Authentication ───

/**
 * Get GitHub auth token via gh CLI.
 */
export function getGitHubToken(): string {
  const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (envToken) return envToken.trim();

  try {
    return execSync('gh auth token', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new ProofShotError(
      'GitHub CLI (gh) is not installed or not authenticated.\n' +
        'Install: https://cli.github.com\n' +
        'Then run: gh auth login',
      error,
    );
  }
}

// ─── Repository Info ───

/**
 * Get the current repo's owner, name, and numeric ID.
 */
export async function getRepoInfo(token: string): Promise<GitHubRepo> {
  const trackedRemoteUrl = getTrackedRemoteUrl();
  const trackedRepo = trackedRemoteUrl ? parseGitHubRemoteUrl(trackedRemoteUrl) : null;
  if (trackedRepo) {
    return getRepoInfoByName(trackedRepo.owner, trackedRepo.repo, token);
  }

  let nwo: string;
  try {
    nwo = execSync('gh repo view --json nameWithOwner -q .nameWithOwner', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new ProofShotError(
      'Could not determine GitHub repository. Are you in a git repo with a GitHub remote?',
      error,
    );
  }

  const [owner, repo] = nwo.split('/');

  return getRepoInfoByName(owner, repo, token);
}

function getTrackedRemoteUrl(): string | null {
  try {
    const upstream = execSync('git rev-parse --abbrev-ref --symbolic-full-name @{u}', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!upstream) return null;

    const remoteName = upstream.split('/', 1)[0];
    return execSync(`git remote get-url ${remoteName}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

export function parseGitHubRemoteUrl(url: string): { owner: string; repo: string } | null {
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  const httpsMatch = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  const sshUrlMatch = url.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshUrlMatch) {
    return { owner: sshUrlMatch[1], repo: sshUrlMatch[2] };
  }

  return null;
}

async function getRepoInfoByName(owner: string, repo: string, token: string): Promise<GitHubRepo> {
  const repoResponse = await githubApi<{
    id: number;
    default_branch: string;
    private: boolean;
  }>(`repos/${owner}/${repo}`, token);

  return {
    owner,
    repo,
    id: repoResponse.id,
    defaultBranch: repoResponse.default_branch,
    isPrivate: repoResponse.private,
  };
}

// ─── PR Detection ───

/**
 * Find the PR number for the current branch, or validate an explicit PR number.
 */
export function getPRNumber(explicitPR?: string): number {
  if (explicitPR) {
    if (!/^\d+$/.test(explicitPR)) {
      throw new ProofShotError(`Invalid PR number: ${explicitPR}`);
    }
    const num = parseInt(explicitPR, 10);
    try {
      execSync(`gh pr view ${num} --json number -q .number`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      throw new ProofShotError(`PR #${num} not found or not accessible.`);
    }
    return num;
  }

  try {
    const numStr = execSync('gh pr view --json number -q .number', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return parseInt(numStr, 10);
  } catch {
    throw new ProofShotError(
      'No PR found for the current branch.\n' +
        'Either specify a PR number: proofshot pr 42\n' +
        'Or create a PR first: gh pr create',
    );
  }
}

// ─── File Upload (GitHub User Attachments) ───

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.webm':
      return 'video/webm';
    case '.mp4':
      return 'video/mp4';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Upload a single file to GitHub's user-attachments endpoint.
 *
 * This is the same mechanism the GitHub web UI uses for drag-and-drop uploads.
 * Flow:
 * 1. POST to /upload/policies/assets with file metadata → get S3 upload form
 * 2. POST file to S3 using the returned form fields
 * 3. Return the permanent github.com/user-attachments/assets/UUID URL
 */
export async function uploadAsset(
  filePath: string,
  token: string,
  repoId: number,
): Promise<UploadedAsset> {
  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  const contentType = getContentType(filePath);

  // Step 1: Request upload policy
  const policyResponse = await fetch('https://github.com/upload/policies/assets', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `token ${token}`,
    },
    body: JSON.stringify({
      name: fileName,
      size: fileSize,
      content_type: contentType,
      repository_id: repoId,
    }),
  });

  if (!policyResponse.ok) {
    const body = await policyResponse.text();
    if ([401, 403, 422].includes(policyResponse.status)) {
      throw new ProofShotError(
        `GitHub web attachment upload failed (${policyResponse.status}).\n` +
          'ProofShot\'s "github-web-attachments" provider uses GitHub\'s internal ' +
          '/upload/policies/assets endpoint, which may reject browser-based gh OAuth auth.\n' +
          'Try one of:\n' +
          '  - proofshot pr --upload-provider repo-contents\n' +
          '  - export GH_TOKEN=<token> and retry\n' +
          '  - proofshot pr --dry-run\n' +
          `GitHub response: ${body}`,
      );
    }

    throw new ProofShotError(
      `GitHub upload policy request failed (${policyResponse.status}): ${body}`,
    );
  }

  const policy = (await policyResponse.json()) as {
    upload_url: string;
    form: Record<string, string>;
    asset: { id: number; href: string };
  };

  // Step 2: Upload file to S3 using the form fields
  const fileBuffer = fs.readFileSync(filePath);
  const formData = new FormData();

  for (const [key, value] of Object.entries(policy.form)) {
    formData.append(key, value);
  }

  // File must be the last field
  const blob = new Blob([fileBuffer], { type: contentType });
  formData.append('file', blob, fileName);

  const uploadResponse = await fetch(policy.upload_url, {
    method: 'POST',
    body: formData,
  });

  if (!uploadResponse.ok && uploadResponse.status !== 204 && uploadResponse.status !== 201) {
    throw new ProofShotError(
      `File upload failed (${uploadResponse.status}): ${await uploadResponse.text()}`,
    );
  }

  return {
    url: policy.asset.href,
    name: fileName,
  };
}

/**
 * Upload multiple files sequentially with progress reporting.
 * Continues past individual failures. Map is keyed by full file path
 * to avoid collisions when files from different sessions share a basename.
 */
export async function uploadAssets(
  options: UploadAssetsOptions,
): Promise<Map<string, UploadedAsset>> {
  if (options.uploadProvider === 'repo-contents') {
    return uploadAssetsToRepoContents(options);
  }

  return uploadAssetsToWebAttachments(options);
}

async function uploadAssetsToWebAttachments(
  options: UploadAssetsOptions,
): Promise<Map<string, UploadedAsset>> {
  const results = new Map<string, UploadedAsset>();
  const { filePaths, token, repo, onProgress } = options;

  for (let i = 0; i < filePaths.length; i += 1) {
    const filePath = filePaths[i];
    const fileName = path.basename(filePath);
    onProgress?.(i + 1, filePaths.length, fileName);

    try {
      const asset = await uploadAsset(filePath, token, repo.id);
      results.set(filePath, asset);
    } catch (error) {
      console.error(`  Failed to upload ${fileName}: ${(error as Error).message}`);
    }
  }

  return results;
}

async function uploadAssetsToRepoContents(
  options: UploadAssetsOptions,
): Promise<Map<string, UploadedAsset>> {
  const results = new Map<string, UploadedAsset>();
  const artifactsBranch = options.artifactsBranch || DEFAULT_ARTIFACTS_BRANCH;

  await ensureArtifactsBranch(options.repo, artifactsBranch, options.token);

  for (let i = 0; i < options.filePaths.length; i += 1) {
    const filePath = options.filePaths[i];
    const fileName = path.basename(filePath);
    options.onProgress?.(i + 1, options.filePaths.length, fileName);

    try {
      const content = fs.readFileSync(filePath, 'base64');
      const uploadPath = path.posix.join(
        options.uploadRoot,
        path.basename(path.dirname(filePath)),
        fileName,
      );

      await githubApi(
        `repos/${options.repo.owner}/${options.repo.repo}/contents/${encodePath(uploadPath)}`,
        options.token,
        {
          method: 'PUT',
          body: JSON.stringify({
            message: `proofshot: add ${uploadPath}`,
            content,
            branch: artifactsBranch,
          }),
        },
      );

      results.set(filePath, {
        url: buildBlobUrl(options.repo, artifactsBranch, uploadPath),
        name: fileName,
      });
    } catch (error) {
      console.error(`  Failed to upload ${fileName}: ${(error as Error).message}`);
    }
  }

  return results;
}

async function ensureArtifactsBranch(
  repo: GitHubRepo,
  branch: string,
  token: string,
): Promise<void> {
  try {
    await githubApi(
      `repos/${repo.owner}/${repo.repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      token,
    );
    return;
  } catch (error) {
    const message = (error as Error).message;
    if (!message.includes('(404)')) throw error;
  }

  const baseRef = await githubApi<{ object: { sha: string } }>(
    `repos/${repo.owner}/${repo.repo}/git/ref/heads/${encodeURIComponent(repo.defaultBranch)}`,
    token,
  );

  await githubApi(`repos/${repo.owner}/${repo.repo}/git/refs`, token, {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/heads/${branch}`,
      sha: baseRef.object.sha,
    }),
  });
}

function buildBlobUrl(repo: GitHubRepo, branch: string, filePath: string): string {
  const encodedBranch = encodeURIComponent(branch);
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repo.owner}/${repo.repo}/blob/${encodedBranch}/${encodedPath}?raw=1`;
}

function encodePath(filePath: string): string {
  return filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function githubApi<T>(
  apiPath: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`https://api.github.com/${apiPath}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ProofShotError(`GitHub API request failed (${response.status}): ${body}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

// ─── PR Comment ───

/**
 * Post a comment on a GitHub PR.
 * Pipes markdown body via stdin to avoid shell quoting issues.
 */
export function postPRComment(prNumber: number, body: string): void {
  try {
    execSync(`gh pr comment ${prNumber} --body-file -`, {
      input: body,
      encoding: 'utf-8',
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    const stderr = error?.stderr?.toString?.() || '';
    throw new ProofShotError(`Failed to post PR comment: ${stderr}`, error);
  }
}
