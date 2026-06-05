import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { resolveGitBranch } from './git';
import {
  CodexSessionSelectionMode,
  CodexStatus,
  CodexStatusDisplayContext,
  QuotaWindowUsage,
  quotaStatusLabel,
  quotaStatusSegments,
  statusItemStyle,
  statusLabel,
  tokenStatusLabel
} from './status';
import { CodexStatusProvider, createStatusProvider, normalizeRawStatusPayload, resolveStatusFilePath } from './statusProvider';
import {
  CodexSessionCandidate,
  collectCodexSessionCandidates,
  parseCodexSessionCandidate,
  parseCodexSessionStatus,
  selectCodexSessionCandidate
} from './statusWriter';

const configSection = 'codexStatusLine';
const statusBarPriority = 100;
const quotaSegmentItemCount = 4;

let statusItem: vscode.StatusBarItem | undefined;
let quotaSegmentItems: vscode.StatusBarItem[] = [];
let outputChannel: vscode.OutputChannel | undefined;
let provider: CodexStatusProvider | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let lastStatus: CodexStatus | undefined;
let lastDisplayContext: CodexStatusDisplayContext | undefined;
let terminalBindings = new Map<vscode.Terminal, string>();
let terminalSeenAt = new Map<vscode.Terminal, number>();

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('Codex Status Line');
  statusItem = vscode.window.createStatusBarItem('codexStatusLine.status', vscode.StatusBarAlignment.Left, statusBarPriority);
  statusItem.name = 'Codex Status Line';
  statusItem.command = 'codexStatusLine.showDetails';
  quotaSegmentItems = Array.from({ length: quotaSegmentItemCount }, (_, index) => {
    const item = vscode.window.createStatusBarItem(
      `codexStatusLine.status.segment${index}`,
      vscode.StatusBarAlignment.Left,
      statusBarPriority - index
    );
    item.name = 'Codex Status Line';
    item.command = 'codexStatusLine.showDetails';
    return item;
  });

  context.subscriptions.push(
    outputChannel,
    statusItem,
    ...quotaSegmentItems,
    vscode.commands.registerCommand('codexStatusLine.showDetails', showDetails),
    vscode.commands.registerCommand('codexStatusLine.openSettings', openSettings),
    vscode.commands.registerCommand('codexStatusLine.refresh', () => refreshStatus()),
    vscode.commands.registerCommand('codexStatusLine.printToTerminal', printToTerminal),
    vscode.commands.registerCommand('codexStatusLine.bindActiveTerminal', bindActiveTerminal),
    vscode.window.onDidChangeActiveTerminal(() => {
      rememberTerminal(vscode.window.activeTerminal);
      void refreshStatus();
    }),
    vscode.window.onDidOpenTerminal((terminal) => {
      rememberTerminal(terminal);
    }),
    vscode.window.onDidChangeTerminalShellIntegration(() => {
      void refreshStatus();
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      terminalBindings.delete(terminal);
      terminalSeenAt.delete(terminal);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(configSection)) {
        configure();
      }
    })
  );

  for (const terminal of vscode.window.terminals) {
    rememberTerminal(terminal);
  }
  rememberTerminal(vscode.window.activeTerminal);
  configure();
}

export function deactivate(): void {
  stopRefresh();
}

function configure(): void {
  stopRefresh();

  const config = vscode.workspace.getConfiguration(configSection);
  const enabled = config.get<boolean>('enabled', true);

  if (!enabled) {
    statusItem?.hide();
    hideQuotaSegmentItems();
    return;
  }

  const workspaceRoots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  const statusFilePath = resolveStatusFilePath(config.get<string>('statusFilePath', ''), workspaceRoots);
  provider = createStatusProvider(statusFilePath);
  if (statusItem) {
    statusItem.text = statusLabel('unknown');
    statusItem.show();
  }
  hideQuotaSegmentItems();
  void refreshStatus();

  const refreshIntervalMs = Math.max(500, config.get<number>('refreshIntervalMs', 2000));
  refreshTimer = setInterval(() => void refreshStatus(), refreshIntervalMs);
}

function stopRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

async function refreshStatus(): Promise<void> {
  if (!statusItem || !provider) {
    return;
  }

  lastStatus = await getStatusForActiveTerminal();
  lastDisplayContext = await getStatusDisplayContext();
  const tooltip = buildTooltip(lastStatus, lastDisplayContext);
  if (applyQuotaSegmentItems(lastStatus, lastDisplayContext, tooltip)) {
    statusItem.hide();
    return;
  }

  hideQuotaSegmentItems();
  statusItem.text = tokenStatusLabel(lastStatus) ?? statusLabel(lastStatus.state);
  statusItem.show();
  applyStatusItemStyle(lastStatus);
  statusItem.tooltip = tooltip;
}

function buildTooltip(status: CodexStatus, displayContext: CodexStatusDisplayContext | undefined): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**Codex Status Line**\n\n`);
  tooltip.appendMarkdown(`Shown in the VS Code bottom status bar.\n\n`);
  tooltip.appendMarkdown(`State: \`${status.state}\`\n\n`);
  tooltip.appendMarkdown(`Source: \`${status.source}\``);

  if (status.session) {
    tooltip.appendMarkdown(`\n\nSelection: \`${selectionModeLabel(status.session.mode)}\``);
    if (status.session.sessionId) {
      tooltip.appendMarkdown(`\n\nSession: \`${escapeMarkdown(status.session.sessionId)}\``);
    }
    if (status.session.cwd) {
      tooltip.appendMarkdown(`\n\nSession cwd: \`${escapeMarkdown(status.session.cwd)}\``);
    }
  }

  if (displayContext?.folderName) {
    tooltip.appendMarkdown(`\n\nFolder: \`${escapeMarkdown(displayContext.folderName)}\``);
  }

  if (displayContext?.gitBranch) {
    tooltip.appendMarkdown(`\n\nGit branch: \`${escapeMarkdown(displayContext.gitBranch)}\``);
  }

  if (status.model) {
    tooltip.appendMarkdown(`\n\nModel: \`${escapeMarkdown(status.model)}\``);
  }

  if (status.context?.percentUsed !== undefined) {
    tooltip.appendMarkdown(`\n\nContext usage: \`${status.context.percentUsed}%\``);
  }

  if (status.context?.tokensRemaining !== undefined) {
    tooltip.appendMarkdown(`\n\nContext tokens remaining: \`${status.context.tokensRemaining}\``);
  }

  if (status.context?.tokensUsed !== undefined) {
    tooltip.appendMarkdown(`\n\nContext tokens used: \`${status.context.tokensUsed}\``);
  }

  if (status.context?.tokenBudget !== undefined) {
    tooltip.appendMarkdown(`\n\nContext token budget: \`${status.context.tokenBudget}\``);
  }

  appendQuotaWindowTooltip(tooltip, '5-hour quota', status.limits?.fiveHour);
  appendQuotaWindowTooltip(tooltip, 'Weekly quota', status.limits?.weekly);

  if (status.tokenRemaining !== undefined) {
    tooltip.appendMarkdown(`\n\nTokens remaining: \`${status.tokenRemaining}\``);
  }

  if (status.tokenUsed !== undefined) {
    tooltip.appendMarkdown(`\n\nTokens used: \`${status.tokenUsed}\``);
  }

  if (status.tokenBudget !== undefined) {
    tooltip.appendMarkdown(`\n\nToken budget: \`${status.tokenBudget}\``);
  }

  if (status.tokenPercentUsed !== undefined) {
    tooltip.appendMarkdown(`\n\nToken usage: \`${status.tokenPercentUsed}%\``);
  }

  if (status.detail) {
    tooltip.appendMarkdown(`\n\nDetail: ${escapeMarkdown(status.detail)}`);
  }

  return tooltip;
}

function showDetails(): void {
  if (!outputChannel) {
    return;
  }

  outputChannel.clear();
  outputChannel.appendLine('Codex Status Line');
  outputChannel.appendLine('');

  if (!lastStatus) {
    outputChannel.appendLine('No status has been read yet.');
  } else {
    outputChannel.appendLine(`State: ${lastStatus.state}`);
    outputChannel.appendLine(`Source: ${lastStatus.source}`);
    if (lastStatus.session) {
      outputChannel.appendLine(`Selection: ${selectionModeLabel(lastStatus.session.mode)}`);
      if (lastStatus.session.sessionId) {
        outputChannel.appendLine(`Session: ${lastStatus.session.sessionId}`);
      }
      if (lastStatus.session.cwd) {
        outputChannel.appendLine(`Session cwd: ${lastStatus.session.cwd}`);
      }
      if (lastStatus.session.sessionFile) {
        outputChannel.appendLine(`Session file: ${lastStatus.session.sessionFile}`);
      }
    }
    if (lastDisplayContext?.folderName) {
      outputChannel.appendLine(`Folder: ${lastDisplayContext.folderName}`);
    }
    if (lastDisplayContext?.gitBranch) {
      outputChannel.appendLine(`Git branch: ${lastDisplayContext.gitBranch}`);
    }
    outputChannel.appendLine(`Updated: ${lastStatus.updatedAt.toISOString()}`);
    if (lastStatus.model) {
      outputChannel.appendLine(`Model: ${lastStatus.model}`);
    }
    appendQuotaDetails(lastStatus);
    if (lastStatus.detail) {
      outputChannel.appendLine(`Detail: ${lastStatus.detail}`);
    }
  }

  outputChannel.show(true);
}

async function getStatusForActiveTerminal(): Promise<CodexStatus> {
  const activeTerminal = vscode.window.activeTerminal;
  rememberTerminal(activeTerminal);
  const boundSessionFile = activeTerminal ? terminalBindings.get(activeTerminal) : undefined;
  if (boundSessionFile) {
    const status = await readSessionStatus(boundSessionFile, 'manual-binding');
    if (status.context) {
      return status;
    }
  }

  const terminalCwd = getTerminalCwd(activeTerminal);
  if (activeTerminal && terminalCwd) {
    const candidates = await collectCodexSessionCandidates();
    const candidate = selectCodexSessionCandidate(candidates, {
      cwd: terminalCwd,
      allowFallback: false,
      minMtimeMs: terminalSeenAt.get(activeTerminal)
    });
    if (candidate) {
      return readSessionStatus(candidate.sessionFile, 'active-terminal', candidate);
    }

    return emptyTerminalStatus(activeTerminal, terminalCwd);
  }

  return getFallbackStatus();
}

function rememberTerminal(terminal: vscode.Terminal | undefined): void {
  if (terminal && !terminalSeenAt.has(terminal)) {
    terminalSeenAt.set(terminal, Date.now());
  }
}

function emptyTerminalStatus(terminal: vscode.Terminal, cwd: string): CodexStatus {
  return {
    state: 'waiting',
    detail: `No Codex session has been observed for terminal "${terminal.name}"`,
    source: 'active-terminal',
    context: {
      tokensUsed: 0,
      percentUsed: 0
    },
    session: {
      mode: 'active-terminal',
      cwd
    },
    updatedAt: new Date()
  };
}

async function getFallbackStatus(): Promise<CodexStatus> {
  const fallbackStatus = await provider?.getStatus();
  if (fallbackStatus && fallbackStatus.source !== 'not-configured') {
    return fallbackStatus;
  }

  const candidate = selectCodexSessionCandidate(await collectCodexSessionCandidates(), {
    allowFallback: true
  });
  if (candidate) {
    return readSessionStatus(candidate.sessionFile, 'fallback', candidate);
  }

  if (fallbackStatus) {
    return fallbackStatus;
  }

  return {
    state: 'unknown',
    detail: 'No local status source configured',
    source: 'not-configured',
    session: { mode: 'not-configured' },
    updatedAt: new Date()
  };
}

async function readSessionStatus(
  sessionFile: string,
  mode: CodexSessionSelectionMode,
  knownCandidate?: CodexSessionCandidate
): Promise<CodexStatus> {
  try {
    const content = await readFile(sessionFile, 'utf8');
    const status = parseCodexSessionStatus(content);
    const candidate = knownCandidate ?? parseCodexSessionCandidate(content, sessionFile, Date.now());
    return normalizeRawStatusPayload(status, 'codex-session-log', {
      mode,
      sessionFile,
      sessionId: candidate?.sessionId,
      cwd: candidate?.cwd
    });
  } catch (error) {
    const fallbackStatus = await provider?.getStatus();
    if (fallbackStatus) {
      return fallbackStatus;
    }

    return {
      state: 'waiting',
      detail: error instanceof Error ? error.message : String(error),
      source: 'codex-session-log',
      session: { mode, sessionFile },
      updatedAt: new Date()
    };
  }
}

async function bindActiveTerminal(): Promise<void> {
  const activeTerminal = vscode.window.activeTerminal;
  if (!activeTerminal) {
    void vscode.window.showWarningMessage('No active terminal to bind.');
    return;
  }

  const terminalCwd = getTerminalCwd(activeTerminal);
  const candidates = collectSortedCandidates(await collectCodexSessionCandidates(), terminalCwd);
  if (candidates.length === 0) {
    void vscode.window.showWarningMessage('No Codex session logs were found.');
    return;
  }

  const selected = await vscode.window.showQuickPick(
    candidates.map((candidate) => ({
      label: candidate.sessionId ?? path.basename(candidate.sessionFile),
      description: candidate.cwd,
      detail: candidate.sessionFile,
      candidate
    })),
    {
      title: 'Bind Active Terminal to Codex Session',
      placeHolder: 'Select the Codex session that should drive this terminal status'
    }
  );

  if (!selected) {
    return;
  }

  terminalBindings.set(activeTerminal, selected.candidate.sessionFile);
  await refreshStatus();
}

function collectSortedCandidates(candidates: readonly CodexSessionCandidate[], preferredCwd: string | undefined): CodexSessionCandidate[] {
  const normalizedPreferredCwd = normalizePath(preferredCwd);
  return [...candidates].sort((left, right) => {
    const leftMatches = normalizePath(left.cwd) === normalizedPreferredCwd;
    const rightMatches = normalizePath(right.cwd) === normalizedPreferredCwd;
    if (leftMatches !== rightMatches) {
      return leftMatches ? -1 : 1;
    }

    return right.mtimeMs - left.mtimeMs;
  });
}

function getTerminalCwd(terminal: vscode.Terminal | undefined): string | undefined {
  const shellCwd = terminal?.shellIntegration?.cwd?.fsPath;
  if (shellCwd) {
    return shellCwd;
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function getStatusDisplayContext(): Promise<CodexStatusDisplayContext> {
  const cwd = getTerminalCwd(vscode.window.activeTerminal);
  const folderName = cwd ? path.basename(cwd) : undefined;
  const gitBranch = cwd ? await resolveGitBranch(cwd) : undefined;

  return {
    folderName,
    gitBranch
  };
}

function selectionModeLabel(mode: CodexSessionSelectionMode): string {
  switch (mode) {
    case 'active-terminal':
      return 'active terminal';
    case 'manual-binding':
      return 'manual binding';
    case 'fallback':
      return 'fallback';
    case 'configured-file':
      return 'configured file';
    case 'not-configured':
      return 'not configured';
  }
}

async function openSettings(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${getExtensionId()} ${configSection}`);
}

function normalizePath(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  return path.resolve(value).toLowerCase();
}

async function printToTerminal(): Promise<void> {
  if (provider) {
    lastStatus = await provider.getStatus();
  }

  const status = lastStatus;
  const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal('Codex Status');
  terminal.show();

  if (!status) {
    terminal.sendText('echo Codex status: unknown');
    return;
  }

  terminal.sendText(`echo ${terminalStatusLine(status)}`);
}

function terminalStatusLine(status: CodexStatus): string {
  const tokenLabel = (quotaStatusLabel(status) ?? tokenStatusLabel(status))?.replace(/\$\([^)]+\)\s*/g, '');
  return tokenLabel ?? `Codex status: ${status.state}`;
}

function applyStatusItemStyle(status: CodexStatus): void {
  if (!statusItem) {
    return;
  }

  const style = statusItemStyle(status);
  statusItem.backgroundColor = undefined;
  statusItem.color = style.color;
}

function applyQuotaSegmentItems(
  status: CodexStatus,
  displayContext: CodexStatusDisplayContext | undefined,
  tooltip: vscode.MarkdownString
): boolean {
  const segments = quotaStatusSegments(status, displayContext);
  if (segments.length === 0) {
    return false;
  }

  quotaSegmentItems.forEach((item, index) => {
    const segment = segments[index];
    if (!segment) {
      item.hide();
      return;
    }

    item.text = segment.text;
    item.color = segment.color;
    item.backgroundColor = undefined;
    item.tooltip = tooltip;
    item.show();
  });

  return true;
}

function hideQuotaSegmentItems(): void {
  for (const item of quotaSegmentItems) {
    item.hide();
  }
}

function appendQuotaWindowTooltip(
  tooltip: vscode.MarkdownString,
  label: string,
  quota: QuotaWindowUsage | undefined
): void {
  if (!quota) {
    return;
  }

  if (quota.percentUsed !== undefined) {
    tooltip.appendMarkdown(`\n\n${label}: \`${quota.percentUsed}%\``);
  }

  if (quota.resetsIn) {
    tooltip.appendMarkdown(`\n\n${label} resets in: \`${escapeMarkdown(quota.resetsIn)}\``);
  }

  if (quota.resetsAt) {
    tooltip.appendMarkdown(`\n\n${label} resets at: \`${escapeMarkdown(quota.resetsAt)}\``);
  }
}

function appendQuotaDetails(status: CodexStatus): void {
  if (!outputChannel) {
    return;
  }

  if (status.context) {
    outputChannel.appendLine('');
    outputChannel.appendLine('Context');
    if (status.context.percentUsed !== undefined) {
      outputChannel.appendLine(`  Usage: ${status.context.percentUsed}%`);
    }
    if (status.context.tokensRemaining !== undefined) {
      outputChannel.appendLine(`  Tokens remaining: ${status.context.tokensRemaining}`);
    }
    if (status.context.tokensUsed !== undefined) {
      outputChannel.appendLine(`  Tokens used: ${status.context.tokensUsed}`);
    }
    if (status.context.tokenBudget !== undefined) {
      outputChannel.appendLine(`  Token budget: ${status.context.tokenBudget}`);
    }
  }

  appendQuotaWindowDetails('5-hour quota', status.limits?.fiveHour);
  appendQuotaWindowDetails('Weekly quota', status.limits?.weekly);
}

function appendQuotaWindowDetails(label: string, quota: NonNullable<CodexStatus['limits']>['fiveHour']): void {
  if (!outputChannel || !quota) {
    return;
  }

  outputChannel.appendLine('');
  outputChannel.appendLine(label);
  if (quota.percentUsed !== undefined) {
    outputChannel.appendLine(`  Usage: ${quota.percentUsed}%`);
  }
  if (quota.resetsIn) {
    outputChannel.appendLine(`  Resets in: ${quota.resetsIn}`);
  }
  if (quota.resetsAt) {
    outputChannel.appendLine(`  Resets at: ${quota.resetsAt}`);
  }
}

function getExtensionId(): string {
  const extension = vscode.extensions.getExtension('local-dev.codex-status-line');
  return extension?.id ?? 'local-dev.codex-status-line';
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
}
