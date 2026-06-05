import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  collectCodexSessionCandidates,
  findLatestCodexSessionFile,
  parseCodexSessionCandidate,
  parseCodexSessionStatus,
  selectCodexSessionCandidate,
  selectCodexSessionFile,
  updateStatusFromCodex,
  writeStatusFileAtomic
} from '../statusWriter';

describe('codex status writer parsing', () => {
  it('maps the latest token_count event into status JSON', () => {
    const content = [
      JSON.stringify({
        type: 'turn_context',
        payload: {
          model: 'gpt-5.5'
        }
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 81983,
              total_tokens: 82173
            },
            model_context_window: 258400
          },
          rate_limits: {
            primary: {
              used_percent: 71,
              resets_at: 1780572274
            },
            secondary: {
              used_percent: 17,
              resets_at: 1781141006
            }
          }
        }
      })
    ].join('\n');

    const status = parseCodexSessionStatus(content);

    assert.equal(status.state, 'running');
    assert.equal(status.model, 'gpt-5.5');
    assert.equal(status.context?.tokensUsed, 81983);
    assert.equal(status.context?.tokenBudget, 258400);
    assert.equal(status.context?.tokensRemaining, 176417);
    assert.equal(status.context?.percentUsed, 32);
    assert.equal(status.limits?.fiveHour?.percentUsed, 71);
    assert.equal(status.limits?.fiveHour?.resetsAt, '2026-06-04T11:24:34.000Z');
    assert.equal(status.limits?.weekly?.percentUsed, 17);
  });

  it('uses the last token_count event when a session has multiple turns', () => {
    const content = [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 1000 },
            model_context_window: 10000
          }
        }
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 4200 },
            model_context_window: 10000
          }
        }
      })
    ].join('\n');

    assert.equal(parseCodexSessionStatus(content).context?.percentUsed, 42);
  });

  it('prefers last token usage over cumulative token usage for context used', () => {
    const content = [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 100000 },
            last_token_usage: { input_tokens: 1000 },
            model_context_window: 100000
          }
        }
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 101200 },
            last_token_usage: { input_tokens: 52000 },
            model_context_window: 100000
          }
        }
      })
    ].join('\n');

    const status = parseCodexSessionStatus(content);

    assert.equal(status.context?.tokensUsed, 52000);
    assert.equal(status.context?.percentUsed, 52);
  });

  it('calculates context used from remaining context when available', () => {
    const content = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          context_remaining: 8750,
          last_token_usage: { input_tokens: 9000 },
          model_context_window: 10000
        }
      }
    });

    const status = parseCodexSessionStatus(content);

    assert.equal(status.context?.tokensUsed, 1250);
    assert.equal(status.context?.tokensRemaining, 8750);
    assert.equal(status.context?.percentUsed, 13);
  });

  it('returns an explicit waiting status when token data is missing', () => {
    const status = parseCodexSessionStatus('{"type":"session_meta","payload":{"model":"gpt-5.5"}}\n');

    assert.equal(status.state, 'waiting');
    assert.equal(status.model, 'gpt-5.5');
    assert.equal(status.context, undefined);
  });

  it('extracts lightweight session metadata without requiring quota data', () => {
    const candidate = parseCodexSessionCandidate(JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'session-123',
        cwd: 'C:\\Users\\USER\\repo',
        model: 'gpt-5.5'
      }
    }), 'rollout.jsonl', 42);

    assert.equal(candidate.sessionId, 'session-123');
    assert.equal(candidate.cwd, 'C:\\Users\\USER\\repo');
    assert.equal(candidate.model, 'gpt-5.5');
    assert.equal(candidate.hasTokenCount, false);
  });
});

describe('codex status writer files', () => {
  it('finds the newest jsonl file under the sessions directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-status-writer-'));
    try {
      const sessionsDir = path.join(root, 'sessions', '2026', '06', '04');
      const old = path.join(sessionsDir, 'old.jsonl');
      await writeFixture(old, '{}\n');
      const latest = path.join(sessionsDir, 'latest.jsonl');
      await writeFixture(latest, '{}\n');
      await utimes(old, new Date('2026-06-04T00:00:00Z'), new Date('2026-06-04T00:00:00Z'));
      await utimes(latest, new Date('2026-06-04T00:01:00Z'), new Date('2026-06-04T00:01:00Z'));

      assert.equal(await findLatestCodexSessionFile({ sessionsDir: path.join(root, 'sessions') }), latest);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('selects the newest session matching the requested cwd', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-status-writer-'));
    try {
      const sessionsDir = path.join(root, 'sessions', '2026', '06', '04');
      const repoAOld = path.join(sessionsDir, 'repo-a-old.jsonl');
      const repoANew = path.join(sessionsDir, 'repo-a-new.jsonl');
      const repoBNewest = path.join(sessionsDir, 'repo-b-newest.jsonl');
      await writeFixture(repoAOld, sessionFixture('a-old', path.join(root, 'repo-a')));
      await writeFixture(repoANew, sessionFixture('a-new', path.join(root, 'repo-a')));
      await writeFixture(repoBNewest, sessionFixture('b-newest', path.join(root, 'repo-b')));
      await utimes(repoAOld, new Date('2026-06-04T00:00:00Z'), new Date('2026-06-04T00:00:00Z'));
      await utimes(repoANew, new Date('2026-06-04T00:01:00Z'), new Date('2026-06-04T00:01:00Z'));
      await utimes(repoBNewest, new Date('2026-06-04T00:02:00Z'), new Date('2026-06-04T00:02:00Z'));

      assert.equal(
        await selectCodexSessionFile({
          sessionsDir: path.join(root, 'sessions'),
          cwd: path.join(root, 'repo-a'),
          allowFallback: false
        }),
        repoANew
      );
      assert.equal(await findLatestCodexSessionFile({ sessionsDir: path.join(root, 'sessions') }), repoBNewest);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('does not fabricate a cwd match when only fallback candidates exist', () => {
    const candidate = selectCodexSessionCandidate([
      {
        sessionFile: 'rollout.jsonl',
        mtimeMs: 1,
        cwd: 'C:\\repo-a',
        hasTokenCount: true
      }
    ], {
      cwd: 'C:\\repo-b',
      allowFallback: false
    });

    assert.equal(candidate, undefined);
  });

  it('ignores candidates older than the requested minimum mtime', () => {
    const oldCandidate = {
      sessionFile: 'old.jsonl',
      mtimeMs: 100,
      cwd: 'C:\\repo-a',
      hasTokenCount: true
    };
    const newCandidate = {
      sessionFile: 'new.jsonl',
      mtimeMs: 200,
      cwd: 'C:\\repo-a',
      hasTokenCount: true
    };

    assert.equal(selectCodexSessionCandidate([oldCandidate, newCandidate], {
      cwd: 'C:\\repo-a',
      allowFallback: false,
      minMtimeMs: 150
    })?.sessionFile, 'new.jsonl');
    assert.equal(selectCodexSessionCandidate([oldCandidate], {
      cwd: 'C:\\repo-a',
      allowFallback: false,
      minMtimeMs: 150
    }), undefined);
  });

  it('collects session candidates with token-count availability', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-status-writer-'));
    try {
      const sessionFile = path.join(root, 'sessions', 'rollout.jsonl');
      await writeFixture(sessionFile, sessionFixture('session-123', root));

      const candidates = await collectCodexSessionCandidates({ sessionsDir: path.join(root, 'sessions') });

      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].sessionId, 'session-123');
      assert.equal(candidates[0].cwd, root);
      assert.equal(candidates[0].hasTokenCount, true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('writes status files atomically as JSON', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-status-writer-'));
    try {
      const statusFile = path.join(root, 'codex-status.json');
      await writeStatusFileAtomic(statusFile, { state: 'running', model: 'gpt-5.5' });

      assert.deepEqual(JSON.parse(await readFile(statusFile, 'utf8')), {
        state: 'running',
        model: 'gpt-5.5'
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('updates a status file from a fixture session file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-status-writer-'));
    try {
      const sessionFile = path.join(root, 'rollout.jsonl');
      const statusFile = path.join(root, 'codex-status.json');
      await writeFixture(sessionFile, JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 5000 },
            model_context_window: 20000
          },
          rate_limits: {
            primary: { used_percent: 62 }
          }
        }
      }));

      const result = await updateStatusFromCodex({ sessionFile, statusFile });
      const written = JSON.parse(await readFile(statusFile, 'utf8'));

      assert.equal(result.status.context?.percentUsed, 25);
      assert.equal(written.context.percentUsed, 25);
      assert.equal(written.limits.fiveHour.percentUsed, 62);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

async function writeFixture(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

function sessionFixture(sessionId: string, cwd: string): string {
  return [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: sessionId,
        cwd,
        model: 'gpt-5.5'
      }
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 1000 },
          model_context_window: 10000
        }
      }
    })
  ].join('\n');
}
