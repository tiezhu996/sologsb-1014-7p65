import { redraw } from 'mithril';
import type { ProofCheck, ProofDocument, ProofStep, ProofVersion } from './types';
import {
  bootWorkspace,
  foldAll,
  FORCE_FOLD_ENTRIES,
  FOLD_IDLE_MS,
  LEGACY_KEY,
  persistCheckpointWithCompaction,
  persistLogWithCompaction,
  removeKey,
  STACK_LIMIT,
  StorageQuotaError,
  type Checkpoint,
  type EditLogEntry,
  type EntryKind,
} from './persistence';

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const clone = <T>(value: T): T => structuredClone(value);

export const RULES = ['前提', '定义展开', '代入', '等式变形', '分配律', '同类项合并', '数学归纳', '反证法', '构造法', '结论'];

function sampleSteps(): ProofStep[] {
  return [
    { id: 's1', type: 'premise', statement: '$a,b$ 是实数', rule: '前提', references: [], note: '采用实数域中的交换律与分配律。', counterexample: '', alternative: '' },
    { id: 's2', type: 'derivation', statement: '$(a+b)^2=(a+b)(a+b)$', rule: '定义展开', references: ['s1'], note: '把平方写成两个相同因式之积。', counterexample: '', alternative: '' },
    { id: 's3', type: 'derivation', statement: '$(a+b)(a+b)=a^2+ab+ba+b^2$', rule: '分配律', references: ['s2'], note: '', counterexample: '', alternative: '也可先展开后半部分。' },
    { id: 's4', type: 'derivation', statement: '$a^2+ab+ba+b^2=a^2+2ab+b^2$', rule: '同类项合并', references: ['s3'], note: '由实数的交换律，$ab=ba$。', counterexample: '', alternative: '' },
    { id: 's5', type: 'goal', statement: '$(a+b)^2=a^2+2ab+b^2$', rule: '结论', references: ['s4'], note: '目标已由步骤 1 至 4 逐项推出。', counterexample: '', alternative: '' },
  ];
}

function issueSteps(): ProofStep[] {
  return [
    { id: 'i1', type: 'premise', statement: '$n$ 是正整数', rule: '前提', references: [], note: '', counterexample: '', alternative: '' },
    { id: 'i2', type: 'derivation', statement: '$P(1)$ 成立', rule: '前提', references: ['i1'], note: '归纳基例。', counterexample: '', alternative: '' },
    { id: 'i3', type: 'derivation', statement: '若 $P(k)$ 成立，则 $P(k+1)$ 也成立', rule: '数学归纳', references: ['missing-step'], note: '这里故意保留一个失效引用，用于演示检查。', counterexample: '', alternative: '' },
    { id: 'i4', type: 'goal', statement: '$P(n)$ 对所有正整数 $n$ 成立', rule: '结论', references: ['i3'], note: '尚未补齐归纳假设。', counterexample: '', alternative: '' },
  ];
}

function initialDocuments(): ProofDocument[] {
  const now = new Date().toISOString();
  return [
    {
      id: 'doc-algebra',
      title: '完全平方公式证明',
      author: '数学组',
      goal: '$(a+b)^2=a^2+2ab+b^2$',
      symbols: { a: '实数', b: '实数', P: '关于正整数的命题', n: '正整数', k: '正整数' },
      steps: sampleSteps(),
      versions: [],
      updatedAt: now,
    },
    {
      id: 'doc-induction',
      title: '数学归纳法待核对稿',
      author: '学生工作区',
      goal: '$P(n)$ 对所有正整数 $n$ 成立',
      symbols: { P: '关于正整数的命题', n: '正整数', k: '正整数' },
      steps: issueSteps(),
      versions: [],
      updatedAt: now,
    },
  ];
}

export class ProofStore {
  documents: ProofDocument[];
  activeId: string;
  selectedStepId: string;
  compareVersionId: string;
  dragStepId = '';
  lastInput: HTMLTextAreaElement | HTMLInputElement | null = null;
  undoStack: ProofDocument[][] = [];
  redoStack: ProofDocument[][] = [];
  toast = '';

  /** 最近一次合并出的完整检查点（含文档、版本快照与截至该步的撤销/重做栈） */
  private checkpoint: Checkpoint;
  /** 检查点之上按编号顺序排列、尚未合并的编辑日志 */
  private entries: EditLogEntry[] = [];
  private foldTimer: number | undefined;
  private quotaBlocked = false;
  private lastCompactionNotice = 0;

  constructor() {
    // 重开页面：先读检查点，再按顺序重放未合并日志（含撤销栈恢复）
    const boot = bootWorkspace(initialDocuments);
    this.checkpoint = boot.checkpoint;
    this.entries = boot.entries;
    this.documents = clone(boot.checkpoint.documents);
    this.undoStack = clone(boot.checkpoint.undoStack);
    this.redoStack = clone(boot.checkpoint.redoStack);
    this.activeId = boot.checkpoint.activeId;
    this.selectedStepId = boot.checkpoint.selectedStepId;
    this.compareVersionId = boot.checkpoint.compareVersionId;

    // 引导后立即固化：把启动时重放的日志合并成检查点
    try {
      this.fold();
      if (boot.reason === 'legacy') removeKey(LEGACY_KEY);
    } catch {
      /* 固化失败不阻塞使用，稍后的稳定合并会重试 */
    }
    if (boot.message) this.notify(boot.message);
  }

  get current(): ProofDocument {
    return this.documents.find((item) => item.id === this.activeId) ?? this.documents[0];
  }

  get selectedStep(): ProofStep | undefined {
    return this.current?.steps.find((step) => step.id === this.selectedStepId);
  }

  get checks(): ProofCheck[] {
    if (!this.current) return [];
    return validate(this.current);
  }

  /** 检查点与待合并日志状态，供界面展示持久化进度 */
  get journalInfo(): { checkpointSeq: number; pending: number; foldedAt: string } {
    return { checkpointSeq: this.checkpoint.seq, pending: this.entries.length, foldedAt: this.checkpoint.foldedAt };
  }

  /** Ctrl+S：立即把日志稳定合并成检查点 */
  save(): void {
    try {
      this.fold();
    } catch (error) {
      this.handlePersistError(error);
    }
  }

  /**
   * 记录一次文档改动：
   * 撤销栈在内存中维护，同时按步骤编号追加到浏览器编辑日志。
   */
  private record(kind: EntryKind, before: ProofDocument[]): void {
    const after = clone(this.documents);
    const seq = this.checkpoint.seq + this.entries.length + 1;
    this.entries.push({
      seq,
      kind,
      before,
      after,
      activeId: this.activeId,
      selectedStepId: this.selectedStepId,
      at: new Date().toISOString(),
    });
    this.persistLog();

    // 连续改动较多时立即合并，否则停顿稳定后再合并
    if (this.entries.length >= FORCE_FOLD_ENTRIES) {
      window.clearTimeout(this.foldTimer);
      try {
        this.fold();
      } catch (error) {
        this.handlePersistError(error);
      }
    } else {
      this.scheduleFold();
    }
  }

  private persistLog(): void {
    try {
      const result = persistLogWithCompaction(this.checkpoint, this.entries);
      this.checkpoint = result.checkpoint;
      this.entries = result.entries;
      this.quotaBlocked = false;
      if (result.compacted) {
        const now = Date.now();
        if (now - this.lastCompactionNotice > 4000) {
          this.lastCompactionNotice = now;
          this.notify('存储空间紧张，已把最早的编辑日志分批压缩进检查点');
        }
      }
    } catch (error) {
      this.handlePersistError(error);
    }
  }

  private handlePersistError(error: unknown): void {
    if (error instanceof StorageQuotaError) {
      if (!this.quotaBlocked) {
        this.quotaBlocked = true;
        this.notify('浏览器存储空间不足，且旧日志已压缩完，请先导出稿件再清理空间');
      }
      return;
    }
    throw error;
  }

  private scheduleFold(): void {
    window.clearTimeout(this.foldTimer);
    this.foldTimer = window.setTimeout(() => {
      try {
        this.fold();
      } catch (error) {
        this.handlePersistError(error);
      }
    }, FOLD_IDLE_MS);
  }

  /** 稳定后合并：重放全部未合并日志，落一份完整检查点并清空日志区 */
  private fold(): void {
    window.clearTimeout(this.foldTimer);
    const merged = foldAll(this.checkpoint, this.entries);
    const result = persistCheckpointWithCompaction(merged, []);
    this.checkpoint = result.checkpoint;
    this.entries = result.entries;
    // 极端配额下可能裁掉了最旧的撤销栈层，内存栈与检查点保持一致
    if (result.compacted) {
      this.undoStack = clone(result.checkpoint.undoStack);
      this.redoStack = clone(result.checkpoint.redoStack);
    }
    this.quotaBlocked = false;
  }

  update(mutator: (document: ProofDocument) => void, after?: () => void): void {
    const before = clone(this.documents);
    mutator(this.current);
    after?.();
    this.current.updatedAt = new Date().toISOString();
    this.undoStack.push(before);
    if (this.undoStack.length > STACK_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.record('edit', before);
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    const before = clone(this.documents);
    this.redoStack.push(before);
    this.documents = previous;
    this.ensureSelection();
    this.record('undo', before);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    const before = clone(this.documents);
    this.undoStack.push(before);
    this.documents = next;
    this.ensureSelection();
    this.record('redo', before);
  }

  selectDocument(id: string): void {
    this.activeId = id;
    this.compareVersionId = '';
    this.selectedStepId = this.current?.steps[0]?.id ?? '';
  }

  selectStep(id: string): void {
    this.selectedStepId = id;
  }

  ensureSelection(): void {
    if (!this.documents.some((item) => item.id === this.activeId)) this.activeId = this.documents[0]?.id ?? '';
    if (!this.current?.steps.some((step) => step.id === this.selectedStepId)) {
      this.selectedStepId = this.current?.steps[0]?.id ?? '';
    }
  }

  addDocument(): void {
    const id = uid('doc');
    const document: ProofDocument = {
      id,
      title: '未命名证明',
      author: '本地用户',
      goal: '$A=B$',
      symbols: { A: '待定义对象', B: '待定义对象' },
      steps: [{ id: uid('step'), type: 'premise', statement: '在这里输入前提', rule: '前提', references: [], note: '', counterexample: '', alternative: '' }],
      versions: [],
      updatedAt: new Date().toISOString(),
    };
    const before = clone(this.documents);
    this.undoStack.push(before);
    if (this.undoStack.length > STACK_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.documents.unshift(document);
    this.activeId = id;
    this.selectedStepId = document.steps[0].id;
    this.record('edit', before);
  }

  removeDocument(id: string): void {
    if (this.documents.length <= 1) {
      this.notify('至少保留一个证明文档');
      return;
    }
    const before = clone(this.documents);
    this.undoStack.push(before);
    if (this.undoStack.length > STACK_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.documents = this.documents.filter((item) => item.id !== id);
    this.ensureSelection();
    this.current.updatedAt = new Date().toISOString();
    this.record('edit', before);
  }

  addStep(type: ProofStep['type'] = 'derivation'): void {
    const step: ProofStep = {
      id: uid('step'),
      type,
      statement: type === 'goal' ? '$A=B$' : '输入新的推导式',
      rule: type === 'goal' ? '结论' : '等式变形',
      references: this.selectedStepId ? [this.selectedStepId] : [],
      note: '',
      counterexample: '',
      alternative: '',
    };
    this.update((document) => {
      const selectedIndex = document.steps.findIndex((item) => item.id === this.selectedStepId);
      document.steps.splice(type === 'goal' ? document.steps.length : selectedIndex + 1, 0, step);
    }, () => {
      this.selectedStepId = step.id;
    });
  }

  removeStep(id: string): void {
    this.update((document) => {
      document.steps = document.steps.filter((step) => step.id !== id);
      document.steps.forEach((step) => {
        step.references = step.references.filter((reference) => reference !== id);
      });
    }, () => this.ensureSelection());
  }

  moveStep(sourceId: string, targetId: string): void {
    if (sourceId === targetId) return;
    this.update((document) => {
      const from = document.steps.findIndex((step) => step.id === sourceId);
      const to = document.steps.findIndex((step) => step.id === targetId);
      if (from < 0 || to < 0) return;
      const [moved] = document.steps.splice(from, 1);
      document.steps.splice(to, 0, moved);
    });
  }

  updateStep(patch: Partial<ProofStep>): void {
    const id = this.selectedStepId;
    this.update((document) => {
      const step = document.steps.find((item) => item.id === id);
      if (step) Object.assign(step, patch);
    });
  }

  createVersion(): void {
    this.update((document) => {
      const version: ProofVersion = {
        id: uid('version'),
        name: `版本 ${document.versions.length + 1}`,
        createdAt: new Date().toISOString(),
        steps: clone(document.steps),
        goal: document.goal,
      };
      document.versions.unshift(version);
      this.compareVersionId = version.id;
    });
    this.notify('已保存当前证明快照');
  }

  notify(message: string): void {
    this.toast = message;
    window.setTimeout(() => {
      if (this.toast === message) {
        this.toast = '';
        redraw();
      }
    }, 2200);
  }
}

function stripLatexCommands(text: string): string {
  return text.replace(/\\[A-Za-z]+/g, ' ').replace(/[{}_^]/g, ' ');
}

export function validate(document: ProofDocument): ProofCheck[] {
  const checks: ProofCheck[] = [];
  const ids = new Set(document.steps.map((step) => step.id));
  const symbolKeys = new Set(Object.keys(document.symbols));
  const ignored = new Set(['a', 'A', 'b', 'B', 'n', 'k', 'P', 'Q', 'R', 'x', 'y', 'to', 'text', 'frac', 'sqrt']);

  document.steps.forEach((step, index) => {
    const tokens = stripLatexCommands(step.statement).match(/\b[A-Za-z][A-Za-z0-9']*\b/g) ?? [];
    const unknown = [...new Set(tokens.filter((token) => !symbolKeys.has(token) && !ignored.has(token)))];
    if (unknown.length) {
      checks.push({ id: `symbol-${step.id}`, severity: 'warning', title: '发现未定义符号', detail: `步骤 ${index + 1} 使用了：${unknown.join('、')}`, stepId: step.id });
    }

    step.references.forEach((reference) => {
      if (!ids.has(reference)) {
        checks.push({ id: `missing-${step.id}-${reference}`, severity: 'error', title: '引用步骤不存在', detail: `步骤 ${index + 1} 引用了已删除的步骤 ${reference}`, stepId: step.id });
      }
    });
  });

  const graph = new Map(document.steps.map((step) => [step.id, step.references.filter((id) => ids.has(id))]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleStep = new Set<string>();
  const visit = (id: string, path: string[]): boolean => {
    if (visiting.has(id)) {
      path.slice(path.indexOf(id)).forEach((item) => cycleStep.add(item));
      return true;
    }
    if (visited.has(id)) return false;
    visiting.add(id);
    const hasCycle = (graph.get(id) ?? []).some((next) => visit(next, [...path, id]));
    visiting.delete(id);
    visited.add(id);
    return hasCycle;
  };
  [...graph.keys()].forEach((id) => visit(id, []));
  if (cycleStep.size) {
    checks.push({ id: 'cycle', severity: 'error', title: '检测到循环引用', detail: '引用链形成闭环，请调整步骤关系。', stepId: [...cycleStep][0] });
  }

  const goalStep = document.steps.find((step) => step.type === 'goal' && step.rule === '结论');
  if (!goalStep) {
    checks.push({ id: 'goal-missing', severity: 'error', title: '目标未被证明', detail: '请添加“结论”类型的最终步骤。' });
  } else if (goalStep.references.length === 0) {
    checks.push({ id: 'goal-unlinked', severity: 'warning', title: '结论尚无推导支撑', detail: '最终步骤没有引用任何前置步骤。', stepId: goalStep.id });
  }

  if (!checks.some((check) => check.severity === 'error')) {
    checks.push({ id: 'proof-ok', severity: 'info', title: '结构检查通过', detail: '未发现缺失引用、循环引用或未证明目标。' });
  }
  return checks;
}

export function compareVersion(document: ProofDocument, version: ProofVersion) {
  const result = [];
  const size = Math.max(document.steps.length, version.steps.length);
  for (let index = 0; index < size; index += 1) {
    const before = version.steps[index]?.statement ?? '';
    const after = document.steps[index]?.statement ?? '';
    const kind = !before ? 'added' : !after ? 'removed' : before === after ? 'same' : 'changed';
    result.push({ kind, label: `步骤 ${index + 1}`, before, after } as const);
  }
  return result;
}

export function createId(prefix: string): string {
  return uid(prefix);
}
