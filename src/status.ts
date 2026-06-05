export const codexStates = ['idle', 'running', 'waiting', 'error', 'unknown'] as const;
const statusSeparator = ' | ';

export type CodexState = (typeof codexStates)[number];

export interface CodexStatus {
  state: CodexState;
  detail?: string;
  model?: string;
  context?: ContextUsage;
  limits?: QuotaLimits;
  session?: CodexSessionSelection;
  tokenRemaining?: number;
  tokenUsed?: number;
  tokenBudget?: number;
  tokenPercentUsed?: number;
  source: string;
  updatedAt: Date;
}

export interface CodexStatusDisplayContext {
  folderName?: string;
  gitBranch?: string;
}

export interface ContextUsage {
  tokensRemaining?: number;
  tokensUsed?: number;
  tokenBudget?: number;
  percentUsed?: number;
}

export interface QuotaWindowUsage {
  percentUsed?: number;
  resetsIn?: string;
  resetsAt?: string;
}

export interface QuotaLimits {
  fiveHour?: QuotaWindowUsage;
  weekly?: QuotaWindowUsage;
}

export type CodexSessionSelectionMode = 'configured-file' | 'active-terminal' | 'manual-binding' | 'fallback' | 'not-configured';

export interface CodexSessionSelection {
  mode: CodexSessionSelectionMode;
  sessionId?: string;
  sessionFile?: string;
  cwd?: string;
}

export interface RawStatusPayload {
  state?: unknown;
  detail?: unknown;
  model?: unknown;
  context?: RawContextUsage;
  limits?: RawQuotaLimits;
  tokenRemaining?: unknown;
  tokenUsed?: unknown;
  tokenBudget?: unknown;
  tokenPercentUsed?: unknown;
}

export interface RawContextUsage {
  tokensRemaining?: unknown;
  tokensUsed?: unknown;
  tokenBudget?: unknown;
  percentUsed?: unknown;
}

export interface RawQuotaWindowUsage {
  percentUsed?: unknown;
  resetsIn?: unknown;
  resetsAt?: unknown;
}

export interface RawQuotaLimits {
  fiveHour?: RawQuotaWindowUsage;
  weekly?: RawQuotaWindowUsage;
}

export function normalizeState(value: unknown): CodexState {
  if (typeof value !== 'string') {
    return 'unknown';
  }

  const normalized = value.trim().toLowerCase();
  return codexStates.includes(normalized as CodexState)
    ? (normalized as CodexState)
    : 'unknown';
}

export function sanitizeDetail(value: unknown, maxLength = 120): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const compact = value
    .replace(/[A-Za-z]:\\[^\s]+/g, '[path]')
    .replace(/\/[^\s]+/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim();

  if (!compact) {
    return undefined;
  }

  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function sanitizeLabel(value: unknown, maxLength = 40): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return undefined;
  }

  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function normalizeTokenCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.round(value);
}

export function normalizePercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

export function tokenPercentUsed(tokenUsed?: number, tokenBudget?: number): number | undefined {
  if (tokenUsed === undefined || tokenBudget === undefined || tokenBudget <= 0) {
    return undefined;
  }

  return normalizePercent((tokenUsed / tokenBudget) * 100);
}

export function normalizeContextUsage(payload: RawContextUsage | undefined): ContextUsage | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const tokensRemaining = normalizeTokenCount(payload.tokensRemaining);
  const tokensUsed = normalizeTokenCount(payload.tokensUsed);
  const tokenBudget = normalizeTokenCount(payload.tokenBudget);
  const percentUsed = normalizePercent(payload.percentUsed) ?? tokenPercentUsed(tokensUsed, tokenBudget);

  if (
    tokensRemaining === undefined &&
    tokensUsed === undefined &&
    tokenBudget === undefined &&
    percentUsed === undefined
  ) {
    return undefined;
  }

  return {
    tokensRemaining,
    tokensUsed,
    tokenBudget,
    percentUsed
  };
}

export function normalizeQuotaWindow(payload: RawQuotaWindowUsage | undefined): QuotaWindowUsage | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const percentUsed = normalizePercent(payload.percentUsed);
  const resetsIn = sanitizeLabel(payload.resetsIn, 30);
  const resetsAt = sanitizeLabel(payload.resetsAt, 40);

  if (percentUsed === undefined && resetsIn === undefined && resetsAt === undefined) {
    return undefined;
  }

  return {
    percentUsed,
    resetsIn,
    resetsAt
  };
}

export function normalizeQuotaLimits(payload: RawQuotaLimits | undefined): QuotaLimits | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const fiveHour = normalizeQuotaWindow(payload.fiveHour);
  const weekly = normalizeQuotaWindow(payload.weekly);

  if (!fiveHour && !weekly) {
    return undefined;
  }

  return {
    fiveHour,
    weekly
  };
}

export function tokenStatusLabel(status: Pick<CodexStatus, 'tokenRemaining' | 'tokenPercentUsed'>): string | undefined {
  if (status.tokenRemaining === undefined && status.tokenPercentUsed === undefined) {
    return undefined;
  }

  const parts: string[] = ['$(symbol-numeric) Codex'];

  if (status.tokenRemaining !== undefined) {
    parts.push(`${formatTokenCount(status.tokenRemaining)} left`);
  }

  if (status.tokenPercentUsed !== undefined) {
    parts.push(`${status.tokenPercentUsed}% used`);
  }

  return parts.join(' ');
}

export interface StatusItemStyle {
  color?: string;
  backgroundColor?: 'warning' | 'error';
}

export function quotaStatusLabel(
  status: Pick<CodexStatus, 'context' | 'limits' | 'model'>,
  displayContext: CodexStatusDisplayContext = {}
): string | undefined {
  const contextPercent = status.context?.percentUsed;
  if (contextPercent === undefined) {
    return undefined;
  }

  const parts: string[] = [];

  const folderName = sanitizeLabel(displayContext.folderName, 24);
  const gitBranch = sanitizeLabel(displayContext.gitBranch, 30);

  if (folderName) {
    parts.push(`$(folder) ${folderName}`);
  }

  if (gitBranch) {
    parts.push(`$(git-branch) ${gitBranch}`);
  }

  if (status.model) {
    parts.push(`$(sparkle) ${status.model}`);
  }

  parts.push(usageSegment('C', contextPercent));

  if (status.limits?.fiveHour?.percentUsed !== undefined) {
    parts.push(usageSegment('5H', status.limits.fiveHour.percentUsed));
  }

  if (status.limits?.weekly?.percentUsed !== undefined) {
    parts.push(weeklyUsageSegment(status.limits.weekly.percentUsed));
  }

  return parts.join(statusSeparator);
}

export function statusItemStyle(status: Pick<CodexStatus, 'context'>): StatusItemStyle {
  if (status.context?.percentUsed === undefined) {
    return {};
  }

  return { color: '#7dd3fc' };
}

export function progressBar(percent: number, width = 12): string {
  const normalized = normalizePercent(percent) ?? 0;
  const safeWidth = Math.max(1, Math.round(width));
  const filled = Math.round((normalized / 100) * safeWidth);
  return `${'\u2588'.repeat(filled)}${'\u2591'.repeat(safeWidth - filled)}`;
}

function usageSegment(label: string, percent: number): string {
  const normalized = normalizePercent(percent) ?? 0;
  return `${label} ${progressBar(normalized, 8)} ${normalized}%`;
}

function weeklyUsageSegment(percent: number): string {
  const normalized = normalizePercent(percent) ?? 0;
  return `W ${normalized}% ${progressBar(normalized, 8)}`;
}

export function statusLabel(state: CodexState): string {
  switch (state) {
    case 'idle':
      return '$(circle-outline) Codex idle';
    case 'running':
      return '$(sync~spin) Codex running';
    case 'waiting':
      return '$(question) Codex waiting';
    case 'error':
      return '$(error) Codex error';
    case 'unknown':
      return '$(circle-slash) Codex unknown';
  }
}

function formatTokenCount(value: number): string {
  if (value >= 1000) {
    return `${Number((value / 1000).toFixed(1))}k`;
  }

  return String(value);
}
