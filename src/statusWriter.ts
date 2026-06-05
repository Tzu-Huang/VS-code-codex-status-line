import { constants } from 'node:fs';
import { access, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RawStatusPayload } from './status';

export interface StatusWriterOptions {
  readonly codexHome?: string;
  readonly sessionsDir?: string;
  readonly sessionFile?: string;
  readonly statusFile: string;
}

export interface WatchStatusWriterOptions extends StatusWriterOptions {
  readonly intervalMs: number;
}

export interface CodexStatusWriterResult {
  readonly status: RawStatusPayload;
  readonly sessionFile?: string;
  readonly wrote: boolean;
}

interface CandidateFile {
  readonly fullPath: string;
  readonly mtimeMs: number;
}

export interface CodexSessionCandidate {
  readonly sessionFile: string;
  readonly mtimeMs: number;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly hasTokenCount: boolean;
}

export interface CodexSessionSelectionOptions extends Pick<StatusWriterOptions, 'codexHome' | 'sessionsDir'> {
  readonly cwd?: string;
  readonly allowFallback?: boolean;
  readonly minMtimeMs?: number;
}

interface TokenUsage {
  readonly input_tokens?: unknown;
  readonly total_tokens?: unknown;
}

interface RateLimitWindow {
  readonly used_percent?: unknown;
  readonly resets_at?: unknown;
}

interface TokenCountInfo {
  readonly total_token_usage?: TokenUsage;
  readonly last_token_usage?: TokenUsage;
  readonly model_context_window?: unknown;
  readonly context_remaining?: unknown;
  readonly contextRemaining?: unknown;
  readonly remaining_context?: unknown;
  readonly remainingContext?: unknown;
  readonly context_window_remaining?: unknown;
  readonly contextWindowRemaining?: unknown;
}

interface TokenCountPayload {
  readonly info?: TokenCountInfo;
  readonly rate_limits?: {
    readonly primary?: RateLimitWindow;
    readonly secondary?: RateLimitWindow;
  };
}

interface ParsedLine {
  readonly type?: unknown;
  readonly payload?: unknown;
}

export async function updateStatusFromCodex(options: StatusWriterOptions): Promise<CodexStatusWriterResult> {
  const sessionFile = options.sessionFile ?? await findLatestCodexSessionFile(options);
  if (!sessionFile) {
    const status = unavailableStatus('No Codex session log found');
    await writeStatusFileAtomic(options.statusFile, status);
    return { status, wrote: true };
  }

  const content = await readFile(sessionFile, 'utf8');
  const status = parseCodexSessionStatus(content);
  if (!status.context) {
    const unavailable = unavailableStatus('No token_count event found');
    await writeStatusFileAtomic(options.statusFile, unavailable);
    return { status: unavailable, sessionFile, wrote: true };
  }

  await writeStatusFileAtomic(options.statusFile, status);
  return { status, sessionFile, wrote: true };
}

export async function findLatestCodexSessionFile(options: Pick<StatusWriterOptions, 'codexHome' | 'sessionsDir'> = {}): Promise<string | undefined> {
  return selectCodexSessionFile({ ...options, allowFallback: true });
}

export async function selectCodexSessionFile(options: CodexSessionSelectionOptions = {}): Promise<string | undefined> {
  const candidates = await collectCodexSessionCandidates(options);
  const selected = selectCodexSessionCandidate(candidates, options);
  return selected?.sessionFile;
}

export function selectCodexSessionCandidate(
  candidates: readonly CodexSessionCandidate[],
  options: Pick<CodexSessionSelectionOptions, 'cwd' | 'allowFallback' | 'minMtimeMs'> = {}
): CodexSessionCandidate | undefined {
  const sorted = candidates
    .filter((candidate) => options.minMtimeMs === undefined || candidate.mtimeMs >= options.minMtimeMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const requestedCwd = normalizePath(options.cwd);

  if (requestedCwd) {
    const matched = sorted.find((candidate) => normalizePath(candidate.cwd) === requestedCwd);
    if (matched) {
      return matched;
    }
  }

  if (options.allowFallback === false) {
    return undefined;
  }

  return sorted[0];
}

export async function collectCodexSessionCandidates(options: Pick<StatusWriterOptions, 'codexHome' | 'sessionsDir'> = {}): Promise<CodexSessionCandidate[]> {
  const sessionsDir = options.sessionsDir ?? path.join(options.codexHome ?? defaultCodexHome(), 'sessions');
  try {
    await access(sessionsDir, constants.R_OK);
  } catch {
    return [];
  }

  const files = await collectJsonlFiles(sessionsDir);
  const candidates: CodexSessionCandidate[] = [];
  for (const file of files) {
    const content = await readFile(file.fullPath, 'utf8');
    candidates.push(parseCodexSessionCandidate(content, file.fullPath, file.mtimeMs));
  }

  return candidates;
}

export function parseCodexSessionCandidate(content: string, sessionFile: string, mtimeMs: number): CodexSessionCandidate {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let hasTokenCount = false;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parsed = parseJsonLine(trimmed);
    if (!parsed) {
      continue;
    }

    const metadata = extractSessionMetadata(parsed);
    sessionId = metadata.sessionId ?? sessionId;
    cwd = metadata.cwd ?? cwd;
    model = metadata.model ?? model;
    model = extractModel(parsed) ?? model;
    hasTokenCount = hasTokenCount || Boolean(extractTokenCountPayload(parsed));
  }

  return {
    sessionFile,
    mtimeMs,
    sessionId,
    cwd,
    model,
    hasTokenCount
  };
}

export function parseCodexSessionStatus(content: string): RawStatusPayload {
  let model: string | undefined;
  let firstTokenCount: TokenCountPayload | undefined;
  let latestTokenCount: TokenCountPayload | undefined;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parsed = parseJsonLine(trimmed);
    if (!parsed) {
      continue;
    }

    const lineModel = extractModel(parsed);
    if (lineModel) {
      model = lineModel;
    }

    const tokenCount = extractTokenCountPayload(parsed);
    if (tokenCount) {
      firstTokenCount ??= tokenCount;
      latestTokenCount = tokenCount;
    }
  }

  if (!latestTokenCount) {
    return unavailableStatus('No token_count event found', model);
  }

  const status = tokenCountToStatus(latestTokenCount, model, firstTokenCount);
  return status.context ? status : unavailableStatus('Incomplete token_count event', model);
}

export async function writeStatusFileAtomic(statusFile: string, status: RawStatusPayload): Promise<void> {
  const directory = path.dirname(statusFile);
  const temporaryPath = path.join(directory, `.${path.basename(statusFile)}.${process.pid}.tmp`);
  const content = `${JSON.stringify(status, null, 2)}\n`;
  await writeFile(temporaryPath, content, 'utf8');
  await rename(temporaryPath, statusFile);
}

export function defaultCodexHome(): string {
  return process.env.CODEX_HOME?.split(',')[0]?.trim() || path.join(os.homedir(), '.codex');
}

async function collectJsonlFiles(directory: string): Promise<CandidateFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: CandidateFile[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJsonlFiles(fullPath));
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }

    const metadata = await stat(fullPath);
    files.push({ fullPath, mtimeMs: metadata.mtimeMs });
  }

  return files;
}

function parseJsonLine(line: string): ParsedLine | undefined {
  try {
    const parsed = JSON.parse(line) as ParsedLine;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractModel(line: ParsedLine): string | undefined {
  if (!line.payload || typeof line.payload !== 'object') {
    return undefined;
  }

  const payload = line.payload as { model?: unknown };
  if (typeof payload.model === 'string' && payload.model.trim()) {
    return payload.model.trim();
  }

  return undefined;
}

function extractSessionMetadata(line: ParsedLine): Pick<CodexSessionCandidate, 'sessionId' | 'cwd' | 'model'> {
  if (!line.payload || typeof line.payload !== 'object') {
    return {};
  }

  const payload = line.payload as { id?: unknown; cwd?: unknown; model?: unknown };
  return {
    sessionId: typeof payload.id === 'string' && payload.id.trim() ? payload.id.trim() : undefined,
    cwd: typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : undefined,
    model: typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : undefined
  };
}

function extractTokenCountPayload(line: ParsedLine): TokenCountPayload | undefined {
  if (line.type !== 'event_msg' || !line.payload || typeof line.payload !== 'object') {
    return undefined;
  }

  const payload = line.payload as { type?: unknown };
  return payload.type === 'token_count' ? payload as TokenCountPayload : undefined;
}

function normalizePath(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  return path.resolve(value).toLowerCase();
}

function tokenCountToStatus(
  payload: TokenCountPayload,
  model: string | undefined,
  baselinePayload: TokenCountPayload | undefined
): RawStatusPayload {
  const tokenBudget = asNonNegativeInteger(payload.info?.model_context_window);
  const contextRemaining = firstDefinedNumber(
    payload.info?.context_remaining,
    payload.info?.contextRemaining,
    payload.info?.remaining_context,
    payload.info?.remainingContext,
    payload.info?.context_window_remaining,
    payload.info?.contextWindowRemaining
  );
  const latestTotalInputTokens = asNonNegativeInteger(payload.info?.total_token_usage?.input_tokens);
  const baselineTotalInputTokens = asNonNegativeInteger(baselinePayload?.info?.total_token_usage?.input_tokens);
  const sessionInputTokens = latestTotalInputTokens !== undefined && baselineTotalInputTokens !== undefined
    ? Math.max(0, latestTotalInputTokens - baselineTotalInputTokens)
    : undefined;
  const lastInputTokens = asNonNegativeInteger(payload.info?.last_token_usage?.input_tokens);
  const tokensUsed = contextRemaining !== undefined && tokenBudget !== undefined
    ? Math.max(0, tokenBudget - contextRemaining)
    : lastInputTokens ?? sessionInputTokens;
  const tokensRemaining = contextRemaining ?? (tokensUsed !== undefined && tokenBudget !== undefined
    ? Math.max(0, tokenBudget - tokensUsed)
    : undefined);
  const percentUsed = tokensUsed !== undefined && tokenBudget !== undefined && tokenBudget > 0
    ? clampPercent((tokensUsed / tokenBudget) * 100)
    : undefined;

  return {
    state: 'running',
    model,
    detail: contextRemaining !== undefined
      ? 'Updated from Codex session log token_count event using context remaining'
      : 'Updated from Codex session log token_count event',
    context: {
      tokensUsed,
      tokensRemaining,
      tokenBudget,
      percentUsed
    },
    limits: {
      fiveHour: rateLimitWindowToStatus(payload.rate_limits?.primary),
      weekly: rateLimitWindowToStatus(payload.rate_limits?.secondary)
    }
  };
}

function rateLimitWindowToStatus(window: RateLimitWindow | undefined): { percentUsed?: number; resetsAt?: string } | undefined {
  const percentUsed = clampPercent(window?.used_percent);
  const resetsAt = unixSecondsToIso(window?.resets_at);
  if (percentUsed === undefined && resetsAt === undefined) {
    return undefined;
  }

  return { percentUsed, resetsAt };
}

function unavailableStatus(detail: string, model?: string): RawStatusPayload {
  return {
    state: 'waiting',
    model,
    detail
  };
}

function asNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.round(value);
}

function firstDefinedNumber(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    const normalized = asNonNegativeInteger(value);
    if (normalized !== undefined) {
      return normalized;
    }
  }

  return undefined;
}

function clampPercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function unixSecondsToIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return new Date(value * 1000).toISOString();
}

function parseCliArgs(argv: readonly string[]): WatchStatusWriterOptions {
  const options: {
    codexHome?: string;
    sessionsDir?: string;
    sessionFile?: string;
    statusFile: string;
    intervalMs: number;
  } = {
    intervalMs: 2000,
    statusFile: path.resolve(process.cwd(), 'codex-status.json')
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--codex-home':
        options.codexHome = requireValue(arg, next);
        index += 1;
        break;
      case '--sessions-dir':
        options.sessionsDir = requireValue(arg, next);
        index += 1;
        break;
      case '--session-file':
        options.sessionFile = requireValue(arg, next);
        index += 1;
        break;
      case '--status-file':
        options.statusFile = requireValue(arg, next);
        index += 1;
        break;
      case '--interval-ms':
        options.intervalMs = Math.max(500, Number(requireValue(arg, next)));
        index += 1;
        break;
      case '--watch':
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const watch = args.includes('--watch');
  const options = parseCliArgs(args);

  const runOnce = async () => {
    const result = await updateStatusFromCodex(options);
    const source = result.sessionFile ? ` from ${result.sessionFile}` : '';
    process.stdout.write(`Updated ${options.statusFile}${source}\n`);
  };

  await runOnce();

  if (!watch) {
    return;
  }

  setInterval(() => {
    void runOnce().catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    });
  }, options.intervalMs);
}

if (require.main === module) {
  void runCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
