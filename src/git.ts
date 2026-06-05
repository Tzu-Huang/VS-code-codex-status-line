import { execFile } from 'node:child_process';

export function resolveGitBranch(cwd: string, timeoutMs = 500): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'branch', '--show-current'],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }

        const branch = stdout.trim();
        resolve(branch || undefined);
      }
    );
  });
}
