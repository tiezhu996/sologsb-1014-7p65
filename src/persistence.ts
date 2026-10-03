import type { ProofDocument } from './types';

/**
 * 两层持久化：
 * - 检查点（checkpoint）：稳定后合并出的完整快照（文档、版本快照、撤销/重做栈）。
 * - 编辑日志（edit log）：按步骤编号 seq 顺序追加的单条改动，重开页面时在检查点之上重放。
 */

const STORAGE_PREFIX = 'sologsb-1014';
export const CHECKPOINT_KEY = `${STORAGE_PREFIX}-checkpoint-v2`;
export const LOG_KEY = `${STORAGE_PREFIX}-editlog-v2`;
/** 旧版本只保存整份文档、没有日志区时使用的键 */
export const LEGACY_KEY = `${STORAGE_PREFIX}-proof-workspace-v1`;

/** 撤销/重做栈最多保留的快照层数，同时也是重放恢复时的层数 */
export const STACK_LIMIT = 80;
/** 未合并日志达到该条数时立即合并成检查点 */
export const FORCE_FOLD_ENTRIES = 12;
/** 停顿多久视为「稳定」，随后把日志合并成检查点 */
export const FOLD_IDLE_MS = 1500;
/** 压缩时每批折进检查点的旧日志条数 */
export const COMPACT_BATCH_SIZE = 4;

export type EntryKind = 'edit' | 'undo' | 'redo';

export interface EditLogEntry {
  /** 全局单调递增的步骤编号 */
  seq: number;
  kind: EntryKind;
  /** 改动前的整份文档（用于撤销/重建撤销栈） */
  before: ProofDocument[];
  /** 改动后的整份文档（用于顺序重放/重建重做栈） */
  after: ProofDocument[];
  /** 操作发生时所在的文档 */
  activeId: string;
  /** 操作发生时选中的步骤 */
  selectedStepId: string;
  at: string;
}

export interface Checkpoint {
  format: 2;
  seq: number;
  documents: ProofDocument[];
  /** 最近一次合并时的撤销栈，重放后再按日志补齐 */
  undoStack: ProofDocument[][];
  redoStack: ProofDocument[][];
  activeId: string;
  selectedStepId: string;
  compareVersionId: string;
  foldedAt: string;
}

export interface ReplayState {
  seq: number;
  documents: ProofDocument[];
  undoStack: ProofDocument[][];
  redoStack: ProofDocument[][];
  activeId: string;
  selectedStepId: string;
  compareVersionId: string;
}

export type BootReason = 'fresh' | 'legacy' | 'ok' | 'recovered';

export interface BootResult {
  checkpoint: Checkpoint;
  /** 检查点之上尚未合并、已重放的日志条数 */
  pendingEntries: number;
  /** 已重放但尚未写入新检查点的日志（下次合并时清空） */
  entries: EditLogEntry[];
  reason: BootReason;
  /** 启动时给用户看的恢复/迁移提示 */
  message: string;
}

/** 写入触发配额不足时抛出，调用方据此分批压缩旧日志后重试 */
export class StorageQuotaError extends Error {
  constructor(message = '浏览器存储空间不足') {
    super(message);
    this.name = 'StorageQuotaError';
  }
}

const clone = <T>(value: T): T => structuredClone(value);

export function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException
    && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22);
}

function storageCall(action: () => void): void {
  try {
    action();
  } catch (error) {
    if (isQuotaError(error)) throw new StorageQuotaError();
    throw error;
  }
}

export function readJSON(key: string): string | null {
  return localStorage.getItem(key);
}

export function writeJSON(key: string, value: string): void {
  storageCall(() => localStorage.setItem(key, value));
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 清理失败不影响主流程 */
  }
}

function pushCapped<T>(stack: T[], value: T): T[] {
  const next = [...stack, value];
  if (next.length > STACK_LIMIT) next.shift();
  return next;
}

function isValidDocuments(value: unknown): value is ProofDocument[] {
  return Array.isArray(value) && value.length > 0
    && value.every((item) => item && typeof item === 'object' && typeof (item as ProofDocument).id === 'string'
      && Array.isArray((item as ProofDocument).steps));
}

function isStack(value: unknown): value is ProofDocument[][] {
  return Array.isArray(value) && value.every((layer) => isValidDocuments(layer));
}

export function isValidCheckpoint(value: unknown): value is Checkpoint {
  if (!value || typeof value !== 'object') return false;
  const cp = value as Partial<Checkpoint>;
  return cp.format === 2
    && typeof cp.seq === 'number'
    && isValidDocuments(cp.documents)
    && isStack(cp.undoStack)
    && isStack(cp.redoStack)
    && typeof cp.activeId === 'string'
    && typeof cp.selectedStepId === 'string'
    && typeof cp.compareVersionId === 'string';
}

export function isValidEntry(value: unknown): value is EditLogEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<EditLogEntry>;
  return typeof entry.seq === 'number'
    && (entry.kind === 'edit' || entry.kind === 'undo' || entry.kind === 'redo')
    && isValidDocuments(entry.before)
    && isValidDocuments(entry.after);
}

/**
 * 在某个检查点之上按编号顺序重放日志。
 * 损坏条目或编号缺口会触发跳变恢复：直接落到缺口后第一条日志的 before 快照，
 * 文档内容不丢，仅缺口之前的撤销栈层无法重建。
 */
export function replay(checkpoint: Checkpoint, rawEntries: unknown[]): { state: ReplayState; applied: number; salvaged: boolean } {
  const state: ReplayState = {
    seq: checkpoint.seq,
    documents: clone(checkpoint.documents),
    undoStack: clone(checkpoint.undoStack),
    redoStack: clone(checkpoint.redoStack),
    activeId: checkpoint.activeId,
    selectedStepId: checkpoint.selectedStepId,
    compareVersionId: checkpoint.compareVersionId,
  };

  const entries = rawEntries
    .filter(isValidEntry)
    .filter((entry) => entry.seq > checkpoint.seq)
    .sort((a, b) => a.seq - b.seq);

  let expected = checkpoint.seq + 1;
  let applied = 0;
  let salvaged = false;
  for (const entry of entries) {
    if (entry.seq !== expected) {
      // 编号缺口（常见于压缩写入途中页面崩溃）：跳到第一条可用日志
      salvaged = true;
      state.documents = clone(entry.before);
      // 缺口前的栈层与跳变后的文档不再连续，全部放弃
      state.undoStack = [];
      state.redoStack = [];
    }
    switch (entry.kind) {
      case 'edit':
        state.undoStack = pushCapped(state.undoStack, clone(entry.before));
        state.redoStack = [];
        break;
      case 'undo': {
        const previous = state.undoStack[state.undoStack.length - 1];
        if (previous) state.undoStack = state.undoStack.slice(0, -1);
        // 栈层缺失（刚经历缺口跳变或极端压缩）时仅接受该条快照，不中止后续重放
        if (previous) state.redoStack = pushCapped(state.redoStack, clone(state.documents));
        break;
      }
      case 'redo': {
        const next = state.redoStack[state.redoStack.length - 1];
        if (next) state.redoStack = state.redoStack.slice(0, -1);
        if (next) state.undoStack = pushCapped(state.undoStack, clone(state.documents));
        break;
      }
    }
    state.documents = clone(entry.after);
    state.seq = entry.seq;
    state.activeId = entry.activeId;
    state.selectedStepId = entry.selectedStepId;
    expected = entry.seq + 1;
    applied += 1;
  }
  return { state, applied, salvaged };
}

function checkpointFromState(state: ReplayState, foldedAt = new Date().toISOString()): Checkpoint {
  return {
    format: 2,
    seq: state.seq,
    documents: clone(state.documents),
    undoStack: clone(state.undoStack),
    redoStack: clone(state.redoStack),
    activeId: state.activeId,
    selectedStepId: state.selectedStepId,
    compareVersionId: state.compareVersionId,
    foldedAt,
  };
}

/**
 * 把最早的若干条日志折进检查点：合并后检查点前进，日志区移除已合并部分。
 * 当前文档（当前步骤）与各文档内的版本快照始终完整保留；
 * 空间不足时只裁掉最旧的撤销栈层，不触碰文档内容。
 */
export function advanceCheckpoint(
  checkpoint: Checkpoint,
  entries: EditLogEntry[],
  batchSize = COMPACT_BATCH_SIZE,
): { checkpoint: Checkpoint; entries: EditLogEntry[] } {
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);
  const batch = ordered.slice(0, Math.max(1, batchSize));
  if (!batch.length) return { checkpoint, entries };
  const { state } = replay(checkpoint, batch);
  const next = checkpointFromState(state);
  const mergedSeq = batch[batch.length - 1].seq;
  return { checkpoint: next, entries: ordered.filter((entry) => entry.seq > mergedSeq) };
}

/** 撤销/重做栈仍然过大时，从最旧的栈层开始裁剪（文档与版本快照不动） */
export function trimCheckpointStacks(checkpoint: Checkpoint, keepLayers: number): Checkpoint {
  const trim = (stack: ProofDocument[][]) => (stack.length > keepLayers ? stack.slice(stack.length - keepLayers) : stack);
  return { ...checkpoint, undoStack: trim(checkpoint.undoStack), redoStack: trim(checkpoint.redoStack) };
}

/**
 * 全量合并写入：先写检查点、再清空日志（崩溃时最坏只是日志重复留存，重放不丢东西）。
 * 配额不足时退化为分批压缩：日志先变短，检查点随后逐批前进。
 */
export function persistCheckpointWithCompaction(
  checkpoint: Checkpoint,
  entries: EditLogEntry[] = [],
  maxAttempts = 40,
): { checkpoint: Checkpoint; entries: EditLogEntry[]; compacted: boolean } {
  let cp = checkpoint;
  let logs = entries;
  let compacted = false;
  let stackKeep = STACK_LIMIT;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      writeJSON(CHECKPOINT_KEY, JSON.stringify(cp));
      writeJSON(LOG_KEY, JSON.stringify(logs));
      return { checkpoint: cp, entries: logs, compacted };
    } catch (error) {
      if (!(error instanceof StorageQuotaError)) throw error;
      compacted = true;
      // 存储容量不足：按最早日志分批压缩（日志先行，不产生双份峰值）
      if (logs.some((entry) => entry.seq > cp.seq)) {
        const advanced = advanceCheckpoint(cp, logs);
        logs = advanced.entries;
        try {
          writeJSON(LOG_KEY, JSON.stringify(logs));
          writeJSON(CHECKPOINT_KEY, JSON.stringify(advanced.checkpoint));
          cp = advanced.checkpoint;
          continue;
        } catch (innerError) {
          if (innerError instanceof StorageQuotaError) {
            // 检查点仍写不下：再折一批
            cp = advanced.checkpoint;
            continue;
          }
          throw innerError;
        }
      }
      // 日志已全部合并仍不足：从最旧的撤销/重做栈层开始裁剪（文档与版本快照不动）
      if (stackKeep > 20) stackKeep = 20;
      else if (stackKeep > 5) stackKeep = 5;
      else if (stackKeep > 0) stackKeep = 0;
      else throw error;
      cp = trimCheckpointStacks(cp, stackKeep);
    }
  }
  throw new StorageQuotaError();
}

/** 追加日志，配额不足时先把最早一批日志压缩进检查点再重试 */
export function persistLogWithCompaction(
  checkpoint: Checkpoint,
  entries: EditLogEntry[],
  maxAttempts = 80,
): { checkpoint: Checkpoint; entries: EditLogEntry[]; compacted: boolean } {
  let cp = checkpoint;
  let logs = entries;

  // 第一轮：直接尝试写入新日志
  try {
    writeJSON(LOG_KEY, JSON.stringify(logs));
    return { checkpoint: cp, entries: logs, compacted: false };
  } catch (error) {
    if (!(error instanceof StorageQuotaError)) throw error;
    if (!logs.some((entry) => entry.seq > cp.seq)) throw error;
  }

  // 压缩轮：把最早一批日志折进检查点；先写变短的日志、再写前进的检查点，
  // 占用峰值不超过压缩前。任一步仍因配额失败就继续折最早一批。
  // 若崩溃在两步之间，重放会遇到编号缺口并跳变恢复，文档内容不丢。
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const advanced = advanceCheckpoint(cp, logs);
    cp = advanced.checkpoint;
    logs = advanced.entries;

    let wroteLog = false;
    try {
      writeJSON(LOG_KEY, JSON.stringify(logs));
      wroteLog = true;
      writeJSON(CHECKPOINT_KEY, JSON.stringify(cp));
      return { checkpoint: cp, entries: logs, compacted: true };
    } catch (error) {
      if (!(error instanceof StorageQuotaError)) throw error;
      if (!wroteLog) {
        // 连变短后的日志都写不下：继续折下一批
        if (!logs.some((entry) => entry.seq > cp.seq)) throw error;
        continue;
      }
      // 日志已写入、检查点写不下：也继续折下一批（下轮先更新日志再更新检查点）
      if (!logs.some((entry) => entry.seq > cp.seq)) throw error;
    }
  }
  throw new StorageQuotaError();
}

/** 合并所有未合并日志，生成新的完整检查点并清空日志区 */
export function foldAll(checkpoint: Checkpoint, entries: EditLogEntry[]): Checkpoint {
  const pending = [...entries].filter((entry) => entry.seq > checkpoint.seq).sort((a, b) => a.seq - b.seq);
  if (!pending.length) return { ...checkpoint, foldedAt: new Date().toISOString() };
  const { state } = replay(checkpoint, pending);
  return checkpointFromState(state);
}

export function createInitialCheckpoint(documents: ProofDocument[]): Checkpoint {
  const now = new Date().toISOString();
  return {
    format: 2,
    seq: 0,
    documents: clone(documents),
    undoStack: [],
    redoStack: [],
    activeId: documents[0]?.id ?? '',
    selectedStepId: documents[0]?.steps[0]?.id ?? '',
    compareVersionId: '',
    foldedAt: now,
  };
}

function readLegacyDocuments(): ProofDocument[] | null {
  const raw = readJSON(LEGACY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ProofDocument[];
    return isValidDocuments(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 重开页面时的引导流程：
 * 1. 先读检查点；
 * 2. 再按编号顺序重放未合并日志，恢复文档与撤销/重做栈；
 * 3. 旧稿（没有日志区的 v1 数据）迁移成初始检查点；
 * 4. 检查点损坏时退回旧稿或示例稿。
 */
export function bootWorkspace(seedDocuments: () => ProofDocument[]): BootResult {
  let checkpoint: Checkpoint | null = null;
  let checkpointCorrupt = false;

  const cpRaw = readJSON(CHECKPOINT_KEY);
  if (cpRaw !== null) {
    try {
      const parsed = JSON.parse(cpRaw) as unknown;
      if (isValidCheckpoint(parsed)) checkpoint = parsed;
      else checkpointCorrupt = true;
    } catch {
      checkpointCorrupt = true;
    }
  }

  let reason: BootReason;
  let message = '';

  if (!checkpoint) {
    const legacy = readLegacyDocuments();
    if (legacy) {
      // 旧稿缺少日志区：整体迁移成一份初始检查点
      checkpoint = createInitialCheckpoint(legacy);
      reason = 'legacy';
      message = checkpointCorrupt
        ? '检查点已损坏，已从上次整份保存的旧稿恢复，并迁移为新的检查点格式。'
        : '已把旧版整份保存的稿件迁移为初始检查点，之后的改动会记录在编辑日志中。';
    } else {
      checkpoint = createInitialCheckpoint(seedDocuments());
      reason = checkpointCorrupt ? 'recovered' : 'fresh';
      if (checkpointCorrupt) message = '检查点无法读取，已重建示例工作区。';
    }
  } else {
    reason = 'ok';
  }

  let entries: EditLogEntry[] = [];
  let logCorrupt = false;
  const logRaw = readJSON(LOG_KEY);
  if (logRaw !== null) {
    try {
      const parsed = JSON.parse(logRaw) as unknown;
      if (Array.isArray(parsed)) {
        entries = parsed.filter(isValidEntry).sort((a, b) => a.seq - b.seq);
        if (entries.length !== parsed.length) logCorrupt = true;
        // 编号缺口不再截断：重放时用缺口后第一条日志的 before 快照跳变恢复
      } else {
        logCorrupt = true;
      }
    } catch {
      logCorrupt = true;
      entries = [];
    }
  }

  // 先读检查点，再按顺序重放未合并日志（遇到压缩/崩溃造成的缺口则跳变恢复）
  const { state, applied, salvaged } = replay(checkpoint, entries);
  const restored = checkpointFromState(state);
  const pendingEntries = applied;
  const pendingEntriesList = entries.filter((entry) => entry.seq > checkpoint.seq && entry.seq <= state.seq);

  if (reason === 'ok' && (checkpointCorrupt || logCorrupt || salvaged)) {
    reason = 'recovered';
    const reasons: string[] = [];
    if (logCorrupt) reasons.push('部分编辑日志损坏');
    if (salvaged) reasons.push('日志编号出现缺口（已跳过缺口恢复文档，缺口前的撤销历史无法重建）');
    message = `已从最近检查点恢复${reasons.length ? `（${reasons.join('、')}）` : ''}。`;
  }

  return { checkpoint: restored, pendingEntries, entries: pendingEntriesList, reason, message };
}
