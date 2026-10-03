import type { ProofDocument } from './types';

const CHECKPOINT_KEY = 'sologsb-1014-proof-checkpoint-v2';
const JOURNAL_KEY = 'sologsb-1014-proof-journal-v2';
const LEGACY_STORAGE_KEY = 'sologsb-1014-proof-workspace-v1';
const CHECKPOINT_SCHEMA = 'proof-checkpoint-v2';
const JOURNAL_SCHEMA = 'proof-journal-v2';
const CHECKPOINT_DELAY = 1000;
const MAX_UNDO_DEPTH = 80;

export interface WorkspaceSnapshot {
  documents: ProofDocument[];
  undoStack: ProofDocument[][];
  redoStack: ProofDocument[][];
  activeId: string;
  selectedStepId: string;
  compareVersionId: string;
}

export interface Checkpoint extends WorkspaceSnapshot {
  schema: typeof CHECKPOINT_SCHEMA;
  seq: number;
  createdAt: string;
}

export type JournalKind = 'edit' | 'undo' | 'redo';

export interface JournalEntry extends WorkspaceSnapshot {
  schema: typeof JOURNAL_SCHEMA;
  seq: number;
  kind: JournalKind;
  createdAt: string;
}

export interface LoadResult {
  snapshot: WorkspaceSnapshot;
  seq: number;
  warning: string;
}

export interface AppendResult {
  seq: number;
  compacted: boolean;
}

const clone = <T>(value: T): T => structuredClone(value);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDocumentArray(value: unknown): value is ProofDocument[] {
  return Array.isArray(value)
    && value.every((item) => isRecord(item)
      && typeof item.id === 'string'
      && typeof item.title === 'string'
      && Array.isArray(item.steps)
      && Array.isArray(item.versions));
}

function isDocumentStack(value: unknown): value is ProofDocument[][] {
  return Array.isArray(value) && value.every((item) => isDocumentArray(item));
}

function isSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!isRecord(value)) return false;
  return isDocumentArray(value.documents)
    && isDocumentStack(value.undoStack)
    && isDocumentStack(value.redoStack)
    && typeof value.activeId === 'string'
    && typeof value.selectedStepId === 'string'
    && typeof value.compareVersionId === 'string';
}

function normalizeSnapshot(value: WorkspaceSnapshot): WorkspaceSnapshot {
  return {
    documents: clone(value.documents),
    undoStack: clone(value.undoStack).slice(-MAX_UNDO_DEPTH),
    redoStack: clone(value.redoStack).slice(-MAX_UNDO_DEPTH),
    activeId: value.activeId,
    selectedStepId: value.selectedStepId,
    compareVersionId: value.compareVersionId,
  };
}

function isCheckpoint(value: unknown): value is Checkpoint {
  return isRecord(value)
    && value.schema === CHECKPOINT_SCHEMA
    && typeof value.seq === 'number'
    && Number.isSafeInteger(value.seq)
    && value.seq >= 0
    && typeof value.createdAt === 'string'
    && isSnapshot(value);
}

function isJournalEntry(value: unknown): value is JournalEntry {
  return isRecord(value)
    && value.schema === JOURNAL_SCHEMA
    && typeof value.seq === 'number'
    && Number.isSafeInteger(value.seq)
    && value.seq > 0
    && (value.kind === 'edit' || value.kind === 'undo' || value.kind === 'redo')
    && typeof value.createdAt === 'string'
    && isSnapshot(value);
}

export class WorkspaceStorage {
  private journalText = '';

  private seq = 0;

  private timer: number | null = null;

  constructor(
    private readonly storage: Storage = globalThis.localStorage,
    private readonly createInitialDocuments: () => ProofDocument[] = () => [] as ProofDocument[],
  ) {}

  load(): LoadResult {
    const warnings: string[] = [];
    const checkpoint = this.readCheckpoint();

    const parsedJournal = this.readJournal();
    let malformedWarning = parsedJournal.malformed;
    let gapWarning = false;
    let duplicateWarning = false;
    const accepted: JournalEntry[] = [];
    const acceptedSeqs = new Set<number>();
    let expectedSeq = (checkpoint?.seq ?? 0) + 1;
    let snapshot: WorkspaceSnapshot = checkpoint
      ? normalizeSnapshot(checkpoint)
      : { documents: [], undoStack: [], redoStack: [], activeId: '', selectedStepId: '', compareVersionId: '' };
    let lastSeq = checkpoint?.seq ?? 0;
    let usedJournal = Boolean(checkpoint);

    parsedJournal.entries
      .filter((entry) => entry.seq > (checkpoint?.seq ?? 0))
      .sort((a, b) => a.seq - b.seq)
      .forEach((entry) => {
        if (acceptedSeqs.has(entry.seq)) {
          duplicateWarning = true;
          return;
        }
        if (!usedJournal) {
          snapshot = normalizeSnapshot(entry);
          lastSeq = entry.seq;
          expectedSeq = entry.seq + 1;
          accepted.push(entry);
          acceptedSeqs.add(entry.seq);
          usedJournal = true;
          return;
        }
        if (entry.seq !== expectedSeq) {
          gapWarning = true;
          return;
        }
        snapshot = normalizeSnapshot(entry);
        lastSeq = entry.seq;
        expectedSeq += 1;
        accepted.push(entry);
        acceptedSeqs.add(entry.seq);
      });

    if (malformedWarning) warnings.push('部分编辑日志损坏，已从最近的完整记录恢复。');
    if (gapWarning) warnings.push('检测到日志编号缺口，已从缺口前最近检查点恢复。');
    if (duplicateWarning) warnings.push('检测到重复编辑日志，只保留同一步骤的第一条记录。');

    if (usedJournal) {
      const journalText = accepted.map((entry) => JSON.stringify(entry)).join('\n');
      try {
        this.persistJournal(journalText);
      } catch {
        // 恢复结果已经可用；清理失败不阻断打开页面。
      }
      this.seq = lastSeq;
      return { snapshot: normalizeSnapshot(snapshot), seq: lastSeq, warning: warnings.join(' ') };
    }

    if (checkpoint) {
      this.persistJournal('');
      this.seq = checkpoint.seq;
      this.removeLegacyData();
      return { snapshot: normalizeSnapshot(checkpoint), seq: checkpoint.seq, warning: warnings.join(' ') };
    }

    return this.bootstrapWithoutCheckpoint(warnings);
  }

  append(kind: JournalKind, snapshot: WorkspaceSnapshot): AppendResult {
    const seq = this.seq + 1;
    let compacted = false;
    const serialized = JSON.stringify({
      ...normalizeSnapshot(snapshot),
      schema: JOURNAL_SCHEMA,
      seq,
      kind,
      createdAt: new Date().toISOString(),
    } satisfies JournalEntry);

    try {
      this.storage.setItem(JOURNAL_KEY, this.journalText ? `${this.journalText}\n${serialized}` : serialized);
    } catch (error) {
      if (!this.isQuotaError(error)) throw error;
      this.compactOldestForAppend(seq, kind, snapshot);
      compacted = true;
    }

    this.journalText = this.storage.getItem(JOURNAL_KEY) ?? '';
    this.seq = seq;
    return { seq, compacted };
  }

  checkpointNow(snapshot: WorkspaceSnapshot): Checkpoint {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    const checkpoint = this.writeDurableCheckpoint(this.seq, snapshot);
    this.removeJournalThrough(this.seq);
    return checkpoint;
  }

  scheduleCheckpoint(snapshot: WorkspaceSnapshot, onCheckpoint?: (snapshot: WorkspaceSnapshot) => void): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      try {
        const checkpoint = this.writeDurableCheckpoint(this.seq, snapshot);
        this.removeJournalThrough(this.seq);
        onCheckpoint?.(checkpoint);
      } catch {
        // 未合并日志仍然完整；下一次写入会继续尝试压缩和合并。
      }
    }, CHECKPOINT_DELAY);
  }

  private readCheckpoint(): Checkpoint | null {
    try {
      const raw = this.storage.getItem(CHECKPOINT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (isCheckpoint(parsed)) return parsed;
    } catch {
      // 损坏检查点会由日志或初始迁移兜底。
    }
    return null;
  }

  private readJournal(): { entries: JournalEntry[]; malformed: boolean } {
    const entries: JournalEntry[] = [];
    let malformed = false;
    try {
      this.journalText = this.storage.getItem(JOURNAL_KEY) ?? '';
    } catch {
      return { entries, malformed: true };
    }

    for (const line of this.journalText.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isJournalEntry(parsed)) entries.push(parsed);
        else malformed = true;
      } catch {
        malformed = true;
      }
    }
    return { entries, malformed };
  }

  private bootstrapWithoutCheckpoint(warnings: string[]): LoadResult {
    let documents: ProofDocument[] | null = null;
    try {
      const legacy = this.storage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        const parsed = JSON.parse(legacy) as unknown;
        if (isDocumentArray(parsed)) documents = parsed;
        else warnings.push('旧版稿件无法解析，已创建新的初始检查点。');
      }
    } catch {
      warnings.push('读取旧版稿件失败，已创建新的初始检查点。');
    }

    const snapshot: WorkspaceSnapshot = {
      documents: documents ?? this.createInitialDocuments(),
      undoStack: [],
      redoStack: [],
      activeId: '',
      selectedStepId: '',
      compareVersionId: '',
    };
    snapshot.activeId = snapshot.documents[0]?.id ?? '';
    snapshot.selectedStepId = snapshot.documents[0]?.steps[0]?.id ?? '';

    this.writeDurableCheckpoint(0, snapshot);
    this.seq = 0;
    this.removeJournalThrough(0);
    this.removeLegacyData();

    return {
      snapshot: normalizeSnapshot(snapshot),
      seq: 0,
      warning: warnings.join(' '),
    };
  }

  private compactOldestForAppend(seq: number, kind: JournalKind, snapshot: WorkspaceSnapshot): void {
    const entries = this.readJournal().entries.sort((a, b) => a.seq - b.seq);
    const total = entries.length;
    const batchSizes = [...new Set([
      Math.max(1, Math.ceil(total / 4)),
      Math.max(1, Math.ceil(total / 2)),
      total,
    ])];
    let lastError: unknown = null;

    for (const batchSize of batchSizes) {
      const target = entries[batchSize - 1];
      if (!target) break;
      let persistedTarget: Checkpoint;
      try {
        persistedTarget = this.writeDurableCheckpoint(target.seq, target);
      } catch (error) {
        lastError = error;
        if (!this.isQuotaError(error)) throw error;
        continue;
      }

      const remaining = entries.slice(batchSize);
      const candidates: WorkspaceSnapshot[] = [
        { ...persistedTarget, undoStack: persistedTarget.undoStack, redoStack: persistedTarget.redoStack },
        { ...persistedTarget, undoStack: persistedTarget.undoStack, redoStack: [] },
        { ...persistedTarget, undoStack: [], redoStack: [] },
      ];

      for (const stackBase of candidates) {
        const compactedEntry = this.entryFromStacks(seq, kind, snapshot, stackBase.undoStack, stackBase.redoStack);
        const serializedEntry = JSON.stringify(compactedEntry);
        const remainingText = remaining.map((entry) => JSON.stringify(entry)).join('\n');
        try {
          this.persistJournal(remainingText ? `${remainingText}\n${serializedEntry}` : serializedEntry);
          return;
        } catch (error) {
          lastError = error;
          if (!this.isQuotaError(error)) throw error;
        }
      }
    }

    try {
      this.writeDurableCheckpoint(seq, snapshot);
      this.persistJournal('');
      return;
    } catch (error) {
      if (!this.isQuotaError(error)) throw error;
      lastError = error;
    }

    try {
      this.storage.removeItem(LEGACY_STORAGE_KEY);
      this.writeDurableCheckpoint(seq, snapshot);
      this.persistJournal('');
    } catch (error) {
      throw (this.isQuotaError(error) || this.isQuotaError(lastError))
        ? new DOMException('浏览器存储空间不足，当前步骤和版本快照无法安全写入。', 'QuotaExceededError')
        : (error instanceof Error ? error : new Error('编辑日志压缩失败。'));
    }
  }

  private entryFromStacks(seq: number, kind: JournalKind, snapshot: WorkspaceSnapshot, baseUndo: ProofDocument[][], baseRedo: ProofDocument[][]): JournalEntry {
    const undoStack = clone(baseUndo);
    const redoStack = clone(baseRedo);
    if (kind === 'edit') {
      undoStack.length = Math.max(0, undoStack.length - 1);
      redoStack.length = 0;
    } else if (kind === 'undo') {
      if (undoStack.length) undoStack.pop();
      redoStack.push(clone(snapshot.documents));
    } else {
      undoStack.push(clone(snapshot.documents));
      if (redoStack.length) redoStack.pop();
    }
    if (undoStack.length > MAX_UNDO_DEPTH) undoStack.splice(0, undoStack.length - MAX_UNDO_DEPTH);
    if (redoStack.length > MAX_UNDO_DEPTH) redoStack.splice(0, redoStack.length - MAX_UNDO_DEPTH);

    return {
      ...normalizeSnapshot({ ...snapshot, undoStack, redoStack }),
      schema: JOURNAL_SCHEMA,
      seq,
      kind,
      createdAt: new Date().toISOString(),
    };
  }

  private writeDurableCheckpoint(seq: number, snapshot: WorkspaceSnapshot): Checkpoint {
    const undoLength = snapshot.undoStack.length;
    const redoLength = snapshot.redoStack.length;
    const undoKeeps = this.compactionCounts(undoLength);
    const redoKeeps = this.compactionCounts(redoLength);
    let lastError: unknown = null;

    for (const undoKeep of undoKeeps) {
      for (const redoKeep of redoKeeps) {
        const checkpoint: Checkpoint = {
          ...normalizeSnapshot({
            ...snapshot,
            undoStack: snapshot.undoStack.slice(Math.max(0, undoLength - undoKeep)),
            redoStack: snapshot.redoStack.slice(Math.max(0, redoLength - redoKeep)),
          }),
          schema: CHECKPOINT_SCHEMA,
          seq,
          createdAt: new Date().toISOString(),
        };
        try {
          this.storage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
          this.seq = Math.max(this.seq, seq);
          return checkpoint;
        } catch (error) {
          lastError = error;
          if (!this.isQuotaError(error)) throw error;
        }
      }
    }
    throw lastError ?? new Error('无法写入检查点');
  }

  private compactionCounts(length: number): number[] {
    if (length === 0) return [0];
    const counts = new Set<number>([Math.min(MAX_UNDO_DEPTH, length)]);
    for (let value = length; value > 0;) {
      value = Math.floor(value * 0.75);
      counts.add(Math.min(MAX_UNDO_DEPTH, value));
    }
    counts.add(0);
    return [...counts].sort((a, b) => b - a);
  }

  private removeJournalThrough(seq: number): void {
    const entries = this.readJournal().entries.filter((entry) => entry.seq > seq);
    const text = entries.map((entry) => JSON.stringify(entry)).join('\n');
    try {
      this.persistJournal(text);
    } catch {
      // 检查点已经落盘；冗余日志只占空间，不影响正确性。
    }
  }

  private persistJournal(text: string): void {
    if (text) this.storage.setItem(JOURNAL_KEY, text);
    else this.storage.removeItem(JOURNAL_KEY);
    this.journalText = text;
  }

  private removeLegacyData(): void {
    try {
      this.storage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // 旧键可在后续压缩时再尝试清理。
    }
  }

  private isQuotaError(error: unknown): boolean {
    return error instanceof DOMException
      && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22);
  }
}
