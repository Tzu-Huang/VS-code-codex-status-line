import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolveGitBranch } from '../git';

describe('git branch detection', () => {
  it('returns undefined outside a git repository', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-status-git-'));
    try {
      assert.equal(await resolveGitBranch(root), undefined);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('returns the current branch inside a git repository', async (context) => {
    if (!(await hasGit())) {
      context.skip('git executable is not available');
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-status-git-'));
    try {
      await runGit(root, ['init', '-b', 'feature/status-ui']);

      assert.equal(await resolveGitBranch(root), 'feature/status-ui');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

function hasGit(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['--version'], { windowsHide: true }, (error) => {
      resolve(!error);
    });
  });
}

function runGit(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
