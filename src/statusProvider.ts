import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  CodexSessionSelection,
  CodexStatus,
  normalizeContextUsage,
  normalizeQuotaLimits,
  normalizePercent,
  normalizeState,
  normalizeTokenCount,
  RawStatusPayload,
  sanitizeDetail,
  sanitizeLabel,
  tokenPercentUsed
} from './status';

export interface CodexStatusProvider {
  readonly source: string;
  getStatus(): Promise<CodexStatus>;
}

export class UnknownStatusProvider implements CodexStatusProvider {
  public readonly source = 'not-configured';

  public async getStatus(): Promise<CodexStatus> {
    return {
      state: 'unknown',
      detail: 'No local status source configured',
      source: this.source,
      updatedAt: new Date()
    };
  }
}

export class JsonFileStatusProvider implements CodexStatusProvider {
  public readonly source = 'local-json-file';

  public constructor(private readonly filePath: string) {}

  public async getStatus(): Promise<CodexStatus> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const payload = JSON.parse(content) as RawStatusPayload;
      return normalizeRawStatusPayload(payload, this.source, {
        mode: 'configured-file'
      });
    } catch (error) {
      return {
        state: 'error',
        detail: sanitizeDetail(error instanceof Error ? error.message : String(error)),
        source: this.source,
        updatedAt: new Date()
      };
    }
  }
}

export function normalizeRawStatusPayload(
  payload: RawStatusPayload,
  source: string,
  session?: CodexSessionSelection
): CodexStatus {
  const tokenRemaining = normalizeTokenCount(payload.tokenRemaining);
  const tokenUsed = normalizeTokenCount(payload.tokenUsed);
  const tokenBudget = normalizeTokenCount(payload.tokenBudget);
  const context = normalizeContextUsage(payload.context) ?? normalizeContextUsage({
    tokensRemaining: tokenRemaining,
    tokensUsed: tokenUsed,
    tokenBudget: tokenBudget,
    percentUsed: payload.tokenPercentUsed
  });

  return {
    state: normalizeState(payload.state),
    detail: sanitizeDetail(payload.detail),
    model: sanitizeLabel(payload.model, 24),
    context,
    limits: normalizeQuotaLimits(payload.limits),
    session,
    tokenRemaining,
    tokenUsed,
    tokenBudget,
    tokenPercentUsed: normalizePercent(payload.tokenPercentUsed) ?? tokenPercentUsed(tokenUsed, tokenBudget),
    source,
    updatedAt: new Date()
  };
}

export function resolveStatusFilePath(statusFilePath: string, workspaceRoots: readonly string[] = []): string {
  const trimmed = statusFilePath.trim();
  if (trimmed) {
    return trimmed;
  }

  for (const workspaceRoot of workspaceRoots) {
    const candidate = path.join(workspaceRoot, 'codex-status.json');
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return '';
}

export function createStatusProvider(statusFilePath: string): CodexStatusProvider {
  const resolvedPath = resolveStatusFilePath(statusFilePath);
  return resolvedPath ? new JsonFileStatusProvider(resolvedPath) : new UnknownStatusProvider();
}
