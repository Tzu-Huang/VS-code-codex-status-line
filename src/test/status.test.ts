import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  normalizeContextUsage,
  normalizeQuotaLimits,
  normalizeState,
  progressBar,
  quotaStatusLabel,
  quotaStatusSegments,
  sanitizeDetail,
  statusItemStyle,
  statusLabel,
  tokenPercentUsed,
  tokenStatusLabel
} from '../status';
import { JsonFileStatusProvider, resolveStatusFilePath } from '../statusProvider';

describe('status normalization', () => {
  it('normalizes supported states case-insensitively', () => {
    assert.equal(normalizeState('RUNNING'), 'running');
    assert.equal(normalizeState(' waiting '), 'waiting');
  });

  it('falls back to unknown for unsupported states', () => {
    assert.equal(normalizeState('busy'), 'unknown');
    assert.equal(normalizeState(undefined), 'unknown');
  });
});

describe('detail sanitization', () => {
  it('removes common local path shapes', () => {
    assert.equal(sanitizeDetail('Failed at C:\\Users\\USER\\repo\\file.ts'), 'Failed at [path]');
    assert.equal(sanitizeDetail('Failed at /Users/name/repo/file.ts'), 'Failed at [path]');
  });

  it('truncates long details', () => {
    const detail = sanitizeDetail('x'.repeat(200), 20);
    assert.equal(detail, `${'x'.repeat(17)}...`);
    assert.equal(detail?.length, 20);
  });
});

describe('status labels', () => {
  it('returns a label for each state', () => {
    assert.match(statusLabel('idle'), /Codex idle/);
    assert.match(statusLabel('running'), /Codex running/);
    assert.match(statusLabel('waiting'), /Codex waiting/);
    assert.match(statusLabel('error'), /Codex error/);
    assert.match(statusLabel('unknown'), /Codex unknown/);
  });

  it('prefers token usage labels when token data is present', () => {
    assert.equal(tokenStatusLabel({ tokenRemaining: 12345, tokenPercentUsed: 42 }), '$(symbol-numeric) Codex 12.3k left 42% used');
    assert.equal(tokenStatusLabel({ tokenRemaining: undefined, tokenPercentUsed: undefined }), undefined);
  });

  it('returns a compact quota status label when context usage is present', () => {
    assert.equal(
      quotaStatusLabel({
        model: 'gpt-5.5',
        context: {
          percentUsed: 38,
          tokensRemaining: 12345
        },
        limits: {
          fiveHour: { percentUsed: 62 },
          weekly: { percentUsed: 14 }
        }
      }, {
        folderName: 'Status_line_extension',
        gitBranch: 'main'
      }),
      `$(sparkle) gpt-5.5 C ${'\u2588'.repeat(2)}${'\u2591'.repeat(2)} 38% 5H ${'\u2588'.repeat(2)}${'\u2591'.repeat(2)} 62% W ${'\u2588'.repeat(1)}${'\u2591'.repeat(3)} 14%`
    );
  });

  it('returns category-colored quota status segments', () => {
    assert.deepEqual(
      quotaStatusSegments({
        model: 'gpt-5.5',
        context: {
          percentUsed: 38
        },
        limits: {
          fiveHour: { percentUsed: 62 },
          weekly: { percentUsed: 14 }
        }
      }),
      [
        {
          category: 'model',
          text: '$(sparkle) gpt-5.5',
          color: '#38bdf8'
        },
        {
          category: 'context',
          text: `C ${'\u2588'.repeat(2)}${'\u2591'.repeat(2)} 38%`,
          color: '#2dd4bf'
        },
        {
          category: 'fiveHour',
          text: `5H ${'\u2588'.repeat(2)}${'\u2591'.repeat(2)} 62%`,
          color: '#f472b6'
        },
        {
          category: 'weekly',
          text: `W ${'\u2588'.repeat(1)}${'\u2591'.repeat(3)} 14%`,
          color: '#a78bfa'
        }
      ]
    );
  });

  it('omits unknown quota segments instead of fabricating values', () => {
    assert.equal(
      quotaStatusLabel({
        context: {
          percentUsed: 50
        }
      }),
      `C ${'\u2588'.repeat(2)}${'\u2591'.repeat(2)} 50%`
    );
    assert.equal(quotaStatusLabel({ context: undefined, limits: undefined }), undefined);
  });

  it('keeps detailed quota text out of the visible quota label', () => {
    const label = quotaStatusLabel({
      model: 'gpt-5.5',
      context: {
        percentUsed: 38,
        tokensRemaining: 12345
      },
      limits: {
        fiveHour: {
          percentUsed: 62,
          resetsIn: '2h 10m'
        }
      }
    });

    assert.equal(label?.includes('left'), false);
    assert.equal(label?.includes('2h 10m'), false);
  });

  it('uses the context category color without warning or error backgrounds', () => {
    assert.deepEqual(statusItemStyle({ context: { percentUsed: 10 } }), { color: '#2dd4bf' });
    assert.deepEqual(statusItemStyle({ context: { percentUsed: 95 } }), { color: '#2dd4bf' });
    assert.deepEqual(statusItemStyle({ context: undefined }), {});
  });
});

describe('token usage', () => {
  it('calculates percent used from used and budget counts', () => {
    assert.equal(tokenPercentUsed(4200, 10000), 42);
    assert.equal(tokenPercentUsed(1, 0), undefined);
  });

  it('normalizes context usage from nested token values', () => {
    assert.deepEqual(normalizeContextUsage({
      tokensUsed: 4200,
      tokenBudget: 10000,
      tokensRemaining: 5800
    }), {
      tokensRemaining: 5800,
      tokensUsed: 4200,
      tokenBudget: 10000,
      percentUsed: 42
    });
  });

  it('drops invalid quota values', () => {
    assert.equal(normalizeContextUsage({
      tokensUsed: -1,
      tokenBudget: -1,
      percentUsed: 'nope'
    }), undefined);
    assert.equal(normalizeQuotaLimits({
      fiveHour: { percentUsed: 101, resetsIn: '2h 10m' },
      weekly: { percentUsed: Number.NaN }
    })?.fiveHour?.percentUsed, 100);
  });
});

describe('progress bars', () => {
  it('renders deterministic fixed-width bars', () => {
    assert.equal(progressBar(0), '\u2591'.repeat(12));
    assert.equal(progressBar(38), `${'\u2588'.repeat(5)}${'\u2591'.repeat(7)}`);
    assert.equal(progressBar(100), '\u2588'.repeat(12));
  });
});

describe('status file resolution', () => {
  it('prefers an explicit configured path', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-status-line-'));
    try {
      const explicitPath = path.join(workspaceRoot, 'custom-status.json');
      assert.equal(resolveStatusFilePath(explicitPath, [workspaceRoot]), explicitPath);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it('falls back to codex-status.json in the workspace root', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-status-line-'));
    try {
      const fallbackPath = path.join(workspaceRoot, 'codex-status.json');
      await writeFile(fallbackPath, '{"state":"running"}');
      assert.equal(resolveStatusFilePath('', [workspaceRoot]), fallbackPath);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});

describe('json status provider', () => {
  it('reads nested quota status data', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-status-line-'));
    try {
      const statusPath = path.join(workspaceRoot, 'codex-status.json');
      await writeFile(statusPath, JSON.stringify({
        state: 'running',
        model: 'gpt-5.5',
        context: {
          tokensUsed: 7655,
          tokensRemaining: 12345,
          tokenBudget: 20000
        },
        limits: {
          fiveHour: {
            percentUsed: 62,
            resetsIn: '2h 10m'
          },
          weekly: {
            percentUsed: 14,
            resetsIn: '3d'
          }
        }
      }));

      const status = await new JsonFileStatusProvider(statusPath).getStatus();
      assert.equal(status.state, 'running');
      assert.equal(status.model, 'gpt-5.5');
      assert.equal(status.context?.percentUsed, 38);
      assert.equal(status.context?.tokensRemaining, 12345);
      assert.equal(status.limits?.fiveHour?.percentUsed, 62);
      assert.equal(status.limits?.fiveHour?.resetsIn, '2h 10m');
      assert.equal(status.limits?.weekly?.percentUsed, 14);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it('preserves flat token status compatibility', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-status-line-'));
    try {
      const statusPath = path.join(workspaceRoot, 'codex-status.json');
      await writeFile(statusPath, JSON.stringify({
        state: 'running',
        tokenUsed: 4200,
        tokenBudget: 10000,
        tokenRemaining: 5800
      }));

      const status = await new JsonFileStatusProvider(statusPath).getStatus();
      assert.equal(status.tokenPercentUsed, 42);
      assert.equal(status.context?.percentUsed, 42);
      assert.equal(status.context?.tokensRemaining, 5800);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it('marks json file statuses as configured-file selection', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-status-line-'));
    try {
      const statusPath = path.join(workspaceRoot, 'codex-status.json');
      await writeFile(statusPath, JSON.stringify({
        state: 'running'
      }));

      const status = await new JsonFileStatusProvider(statusPath).getStatus();

      assert.equal(status.session?.mode, 'configured-file');
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
