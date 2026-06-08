export const codexStates = ['idle', 'running', 'waiting', 'error', 'unknown'] as const;
const statusSeparator = ' ';
const compactBarWidth = 4;
const mutedQuotaTextColor = '#64748b';
const minutesPerHour = 60;
const minutesPerDay = minutesPerHour * 24;

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

export type QuotaStatusCategory = 'model' | 'context' | 'fiveHour' | 'weekly';

export interface QuotaStatusSegment {
  category: QuotaStatusCategory;
  text: string;
  color: string;
}

const quotaCategoryColors: Record<QuotaStatusCategory, string> = {
  model: '#38bdf8',
  context: '#2dd4bf',
  fiveHour: '#f472b6',
  weekly: '#a78bfa'
};

export function quotaStatusLabel(
  status: Pick<CodexStatus, 'context' | 'limits' | 'model'>,
  displayContext: CodexStatusDisplayContext = {}
): string | undefined {
  const segments = quotaStatusSegments(status, displayContext);
  if (segments.length === 0) {
    return undefined;
  }

  return segments.map((segment) => segment.text).join(statusSeparator);
}

export function quotaStatusSegments(
  status: Pick<CodexStatus, 'context' | 'limits' | 'model'>,
  displayContext: CodexStatusDisplayContext = {}
): QuotaStatusSegment[] {
  const now = new Date();
  const contextPercent = status.context?.percentUsed;
  if (contextPercent === undefined) {
    return [];
  }

  const segments: QuotaStatusSegment[] = [];

  if (status.model) {
    segments.push({
      category: 'model',
      text: `$(sparkle) ${status.model}`,
      color: quotaCategoryColors.model
    });
  }

  segments.push({
    category: 'context',
    text: usageSegment('C', contextPercent),
    color: quotaCategoryColors.context
  });

  if (status.limits?.fiveHour?.percentUsed !== undefined) {
    segments.push({
      category: 'fiveHour',
      text: usageSegment('5H', status.limits.fiveHour.percentUsed),
      color: quotaCategoryColors.fiveHour
    });

    if (status.limits.fiveHour.resetsIn) {
      segments.push({
        category: 'fiveHour',
        text: resetHintSegment(status.limits.fiveHour.resetsIn),
        color: mutedQuotaTextColor
      });
    } else if (status.limits.fiveHour.resetsAt) {
      const resetHint = resetHintSegmentFromDate(status.limits.fiveHour.resetsAt, now);
      if (resetHint) {
        segments.push({
          category: 'fiveHour',
          text: resetHint,
          color: mutedQuotaTextColor
        });
      }
    }
  }

  if (status.limits?.weekly?.percentUsed !== undefined) {
    segments.push({
      category: 'weekly',
      text: weeklyUsageSegment(status.limits.weekly.percentUsed),
      color: quotaCategoryColors.weekly
    });

    if (status.limits.weekly.resetsIn) {
      segments.push({
        category: 'weekly',
        text: resetHintSegment(status.limits.weekly.resetsIn),
        color: mutedQuotaTextColor
      });
    } else if (status.limits.weekly.resetsAt) {
      const resetHint = resetHintSegmentFromDate(status.limits.weekly.resetsAt, now);
      if (resetHint) {
        segments.push({
          category: 'weekly',
          text: resetHint,
          color: mutedQuotaTextColor
        });
      }
    }
  }

  return segments;
}

export function statusItemStyle(status: Pick<CodexStatus, 'context'>): StatusItemStyle {
  const percentUsed = status.context?.percentUsed;
  if (percentUsed === undefined) {
    return {};
  }

  return { color: quotaCategoryColors.context };
}

export function progressBar(percent: number, width = 12): string {
  const normalized = normalizePercent(percent) ?? 0;
  const safeWidth = Math.max(1, Math.round(width));
  const filled = Math.round((normalized / 100) * safeWidth);
  return `${'\u2588'.repeat(filled)}${'\u2591'.repeat(safeWidth - filled)}`;
}

function usageSegment(label: string, percent: number): string {
  const normalized = normalizePercent(percent) ?? 0;
  return `${label} ${progressBar(normalized, compactBarWidth)} ${normalized}%`;
}

function weeklyUsageSegment(percent: number): string {
  const normalized = normalizePercent(percent) ?? 0;
  return `W ${progressBar(normalized, compactBarWidth)} ${normalized}%`;
}

function resetHintSegment(resetsIn: string): string {
  return `(reset in ${resetsIn})`;
}

function resetHintSegmentFromDate(resetsAt: string, referenceTime: Date): string | undefined {
  const resetAtMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetAtMs)) {
    return undefined;
  }

  const remainingMs = resetAtMs - referenceTime.getTime();
  if (remainingMs <= 0) {
    return undefined;
  }

  const totalMinutes = Math.max(1, Math.round(remainingMs / 60000));
  return `(reset in ${formatDurationMinutes(totalMinutes)})`;
}

function formatDurationMinutes(totalMinutes: number): string {
  const days = Math.floor(totalMinutes / minutesPerDay);
  const hours = Math.floor((totalMinutes % minutesPerDay) / minutesPerHour);
  const minutes = totalMinutes % minutesPerHour;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes}m`);
  }

  return parts.slice(0, 2).join(' ');
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
