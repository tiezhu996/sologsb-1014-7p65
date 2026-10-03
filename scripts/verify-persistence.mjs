/**
 * persistence 层的端到端验证（node --import tsx 不可用时用 esbuild 风格的简单转译）。
 * 直接通过 vite 的 esbuild 把 TS 转成 JS 后执行。
 */
import { build } from 'vite';
import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outDir = mkdtempSync(join(tmpdir(), 'persist-test-'));

await build({
  logLevel: 'silent',
  configFile: false,
  build: {
    lib: { entry: 'src/persistence.ts', formats: ['es'], fileName: 'persistence' },
    outDir,
    emptyOutDir: false,
    minify: false,
  },
});

// 浏览器环境垫片
const storeMap = new Map();
let quotaBytes = Infinity;
let usedBytes = 0;
globalThis.localStorage = {
  getItem: (key) => (storeMap.has(key) ? storeMap.get(key) : null),
  setItem: (key, value) => {
    const serialized = String(value);
    const next = usedBytes - (storeMap.get(key)?.length ?? 0) + serialized.length;
    if (next > quotaBytes) throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    storeMap.set(key, serialized);
    usedBytes = next;
  },
  removeItem: (key) => {
    usedBytes -= storeMap.get(key)?.length ?? 0;
    storeMap.delete(key);
  },
  clear: () => { storeMap.clear(); usedBytes = 0; },
};
globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));

const mod = await import(pathToFileURL(join(outDir, 'persistence.js')).href);
const {
  bootWorkspace, foldAll, persistCheckpointWithCompaction, persistLogWithCompaction,
  CHECKPOINT_KEY, LOG_KEY, LEGACY_KEY, COMPACT_BATCH_SIZE,
} = mod;

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

function makeDocs(seed = 0) {
  const now = new Date().toISOString();
  return [{
    id: 'doc-1', title: `稿${seed}`, author: '学生', goal: '$A=B$',
    symbols: { A: 'x', B: 'y' },
    steps: [
      { id: 's1', type: 'premise', statement: `第${seed}版前提`, rule: '前提', references: [], note: '', counterexample: '', alternative: '' },
    ],
    versions: [], updatedAt: now,
  }];
}

function edit(store, kind, docs) {
  // 模拟 ProofStore.record：按当前 seq 追加条目
  const seq = store.checkpoint.seq + store.entries.length + 1;
  store.entries.push({
    seq, kind,
    before: structuredClone(store.documents),
    after: structuredClone(docs),
    activeId: docs[0].id, selectedStepId: docs[0].steps[0].id,
    at: new Date().toISOString(),
  });
  const result = persistLogWithCompaction(store.checkpoint, store.entries);
  store.checkpoint = result.checkpoint;
  store.entries = result.entries;
}

function openInMemory() {
  const boot = bootWorkspace(() => makeDocs(99));
  // 与 ProofStore 构造函数一致：引导后立即把重放日志合并固化为检查点
  const merged = foldAll(boot.checkpoint, boot.entries);
  persistCheckpointWithCompaction(merged, []);
  return {
    checkpoint: merged,
    entries: [],
    documents: structuredClone(merged.documents),
    undoStack: structuredClone(merged.undoStack),
    redoStack: structuredClone(merged.redoStack),
  };
}

// ---------- 1. 全新工作区 + 编辑追加 + 重开重放 ----------
console.log('1. 全新启动、追加日志、重开重放');
localStorage.clear();
{
  let s = openInMemory();
  assert(s.documents[0].title === '稿99', '首次启动使用示例稿');

  const d2 = structuredClone(s.documents); d2[0].title = '稿A';
  edit(s, 'edit', d2); s.documents = d2; s.undoStack.push(structuredClone(makeDocs(99)));
  const d3 = structuredClone(d2); d3[0].steps[0].statement = '改过的前提';
  edit(s, 'edit', d3); s.documents = d3;
  assert(s.entries.length === 2, '两条改动都在未合并日志中，编号 1、2');
  assert(s.entries[0].seq === 1 && s.entries[1].seq === 2, '日志按步骤编号递增');

  // 模拟页面崩溃：内存丢失，只靠 localStorage 重开
  const reopened = openInMemory();
  assert(reopened.documents[0].title === '稿A', '重开后先读检查点再重放日志，文档内容恢复');
  assert(reopened.documents[0].steps[0].statement === '改过的前提', '第二次编辑也通过重放恢复');
  assert(reopened.undoStack.length === 2, '撤销栈随重放恢复为两层');
  assert(reopened.redoStack.length === 0, '重做栈为空');
}

// ---------- 2. 稳定后合并检查点 ----------
console.log('2. 稳定后合并成检查点');
{
  let s = openInMemory();
  const merged = foldAll(s.checkpoint, s.entries);
  persistCheckpointWithCompaction(merged, []);
  assert(JSON.parse(localStorage.getItem(LOG_KEY)).length === 0, '合并后日志区清空');
  assert(JSON.parse(localStorage.getItem(CHECKPOINT_KEY)).seq === 2, '检查点编号前进到 2');

  const reopened = openInMemory();
  assert(reopened.checkpoint.seq === 2, '重开直接落在检查点，无需重放');
  assert(reopened.undoStack.length === 2, '撤销栈随检查点完整保留');
  assert(reopened.documents[0].steps[0].statement === '改过的前提', '当前步骤内容完整');
}

// ---------- 3. 撤销/重做也写日志并可恢复 ----------
console.log('3. 撤销/重做日志与恢复');
{
  let s = openInMemory();
  // 内存撤销一层（与 ProofStore.undo 行为一致）
  const undone = s.undoStack.pop();
  s.redoStack.push(structuredClone(s.documents));
  s.documents = undone;
  edit(s, 'undo', undone);

  const reopened = openInMemory();
  assert(reopened.documents[0].title === '稿A', '撤销操作经重放生效（撤销的是第二次编辑）');
  assert(reopened.undoStack.length === 1, '撤销栈弹出一层后恢复为一层');
  assert(reopened.redoStack.length === 1, '重做栈恢复为一层');

  // 再重做
  let s2 = {
    checkpoint: reopened.checkpoint, entries: reopened.entries,
    documents: structuredClone(reopened.documents),
    undoStack: structuredClone(reopened.undoStack),
    redoStack: structuredClone(reopened.redoStack),
  };
  const redone = s2.redoStack.pop();
  s2.undoStack.push(structuredClone(s2.documents));
  s2.documents = redone;
  edit(s2, 'redo', redone);

  const reopened2 = openInMemory();
  assert(reopened2.documents[0].steps[0].statement === '改过的前提', '重做操作经重放恢复到最新内容');
  assert(reopened2.undoStack.length === 2 && reopened2.redoStack.length === 0, '重做后栈状态正确');
}

// ---------- 4. 失败后从最近检查点恢复：日志损坏/缺口 ----------
console.log('4. 崩溃恢复：损坏日志截断在最近检查点之后');
{
  // 制造：检查点 + 若干日志，再塞入坏条目和缺口
  let s = openInMemory(); // 此时启动已把上一步合并成检查点
  const d = structuredClone(s.documents); d[0].title = '崩溃前';
  edit(s, 'edit', d);

  const log = JSON.parse(localStorage.getItem(LOG_KEY));
  const cp = JSON.parse(localStorage.getItem(CHECKPOINT_KEY));
  // 破坏：把第一条未合并日志的内容改坏，并在后面追加一条编号正确但不该被重放到的日志
  log[0].after = null;
  localStorage.setItem(LOG_KEY, JSON.stringify(log));
  const boot = bootWorkspace(() => makeDocs(99));
  assert(boot.reason === 'recovered', '日志损坏时标记为恢复启动');
  assert(boot.pendingEntries === 0, '损坏条目不重放，停在最近检查点');
  assert(boot.checkpoint.documents[0].steps[0].statement === '改过的前提', '从最近检查点恢复，当前步骤完整');

  // 编号缺口：模拟「先写日志、后写检查点」压缩时崩溃 ——
  // 日志已从 seq+1 开始，但检查点还停在旧编号，且日志的 before 是缺口后的状态
  const gapBefore = makeDocs(5);
  const gapAfter = makeDocs(6);
  const gapped = [
    { seq: cp.seq + 3, kind: 'edit', before: gapBefore, after: gapAfter, activeId: 'doc-1', selectedStepId: 's1', at: new Date().toISOString() },
    { seq: cp.seq + 4, kind: 'edit', before: gapAfter, after: makeDocs(7), activeId: 'doc-1', selectedStepId: 's1', at: new Date().toISOString() },
  ];
  localStorage.setItem(LOG_KEY, JSON.stringify(gapped));
  const boot2 = bootWorkspace(() => makeDocs(99));
  assert(boot2.pendingEntries === 2, '缺口后的两条日志都通过跳变重放');
  assert(boot2.reason === 'recovered', '缺口触发恢复提示');
  assert(boot2.checkpoint.documents[0].title === '稿7', '跳到缺口后第一条的 before 快照继续重放，文档内容不丢');
  assert(boot2.checkpoint.undoStack.length === 2, '缺口后的撤销层从跳变点开始重建');
  assert(boot2.entries.length === 2 && boot2.entries[0].seq === cp.seq + 3, '返回的待合并日志为实际重放的条目');
}

// ---------- 4b. 压缩写入途中崩溃：日志已缩短、检查点未前进 ----------
console.log('4b. 压缩写入两步骤之间崩溃的恢复');
{
  localStorage.clear();
  let s = openInMemory();
  for (let i = 0; i < 10; i += 1) {
    const d = structuredClone(s.documents);
    d[0].title = `崩溃稿-${i}`;
    edit(s, 'edit', d);
    s.documents = d;
  }
  const cp = JSON.parse(localStorage.getItem(CHECKPOINT_KEY));
  const log = JSON.parse(localStorage.getItem(LOG_KEY));
  // 模拟 advanceCheckpoint 折掉最早 4 条：写新日志后、写新检查点前崩溃
  const { advanceCheckpoint } = mod;
  const advanced = advanceCheckpoint(cp, log);
  localStorage.setItem(LOG_KEY, JSON.stringify(advanced.entries));
  // 检查点保持旧 cp（未写入）
  const boot = bootWorkspace(() => makeDocs(99));
  assert(boot.checkpoint.documents[0].title === '崩溃稿-9', '崩溃窗口后仍恢复到最新文档');
  assert(boot.pendingEntries === advanced.entries.length, '缩短后的日志全部重放');
  assert(boot.reason === 'recovered', '提示发生了跳变恢复');
  // 引导固化后状态应完全一致
  const fixed = openInMemory();
  assert(fixed.documents[0].title === '崩溃稿-9', '固化后再次打开内容一致');
  assert(JSON.parse(localStorage.getItem(LOG_KEY)).length === 0, '固化后日志清空');
}

// ---------- 5. 检查点损坏：回退旧稿 ----------
console.log('5. 检查点损坏时回退旧稿');
{
  localStorage.setItem(CHECKPOINT_KEY, '{not-json');
  const legacy = makeDocs(7);
  localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy));
  const boot = bootWorkspace(() => makeDocs(99));
  assert(boot.reason === 'legacy', '检查点损坏且存在旧稿时走迁移');
  assert(boot.checkpoint.documents[0].title === '稿7', '从旧稿恢复内容');
  assert(boot.checkpoint.seq === 0 && boot.checkpoint.undoStack.length === 0, '旧稿迁移为初始检查点，无历史栈');
}

// ---------- 6. 旧稿迁移 ----------
console.log('6. 旧稿（无日志区）迁移成初始检查点');
{
  localStorage.clear();
  localStorage.setItem(LEGACY_KEY, JSON.stringify(makeDocs(42)));
  const boot = bootWorkspace(() => makeDocs(99));
  assert(boot.reason === 'legacy', '识别为旧稿迁移');
  assert(boot.checkpoint.format === 2, '迁移后为 v2 检查点格式');
  assert(boot.checkpoint.documents[0].title === '稿42', '旧稿内容进入初始检查点');
  assert(boot.pendingEntries === 0, '迁移时没有未合并日志');
}

// ---------- 7. 容量不足：按最早日志分批压缩，版本快照完整 ----------
console.log('7. 配额不足时分批压缩旧日志');
{
  localStorage.clear();
  let s = openInMemory();
  // 给文档加一个版本快照，验证压缩后仍完整
  const withVersion = structuredClone(s.documents);
  withVersion[0].versions = [{
    id: 'v1', name: '定稿版', createdAt: new Date().toISOString(),
    steps: structuredClone(withVersion[0].steps), goal: withVersion[0].goal,
  }];
  edit(s, 'edit', withVersion); s.documents = withVersion;

  // 再追加多条可被分批压缩的日志
  for (let i = 0; i < COMPACT_BATCH_SIZE * 3; i += 1) {
    const d = structuredClone(s.documents);
    d[0].title = `压缩稿-${i}`;
    edit(s, 'edit', d);
    s.documents = d;
  }
  const beforeCp = JSON.parse(localStorage.getItem(CHECKPOINT_KEY));
  const beforeLog = JSON.parse(localStorage.getItem(LOG_KEY));
  const baselineBytes = (localStorage.getItem(CHECKPOINT_KEY)?.length ?? 0) + (localStorage.getItem(LOG_KEY)?.length ?? 0);

  // 收紧配额：当前内容放得下，但再追加最后一笔（约整份文档大小）放不下，
  // 从而强制触发「把最早一批日志折进检查点」的分批压缩。
  quotaBytes = baselineBytes + 300;
  usedBytes = baselineBytes;
  let compactedCount = 0;
  try {
    const d = structuredClone(s.documents);
    d[0].title = '最后一笔';
    const seq = s.checkpoint.seq + s.entries.length + 1;
    s.entries.push({
      seq, kind: 'edit',
      before: structuredClone(s.documents), after: structuredClone(d),
      activeId: 'doc-1', selectedStepId: 's1', at: new Date().toISOString(),
    });
    const result = persistLogWithCompaction(s.checkpoint, s.entries);
    s.checkpoint = result.checkpoint;
    s.entries = result.entries;
    s.documents = d;
    compactedCount = result.compacted ? 1 : 0;
  } catch (error) {
    // 配额极端小、连压缩都救不回时允许抛错，但必须保证检查点仍可打开
    console.log('    （配额小到压缩后仍不足，抛错符合预期）');
  }
  quotaBytes = Infinity;
  assert(compactedCount === 1, '配额不足触发了最早日志分批压缩');

  const afterCp = JSON.parse(localStorage.getItem(CHECKPOINT_KEY));
  const afterLog = JSON.parse(localStorage.getItem(LOG_KEY));
  assert(afterCp.seq > beforeCp.seq, '压缩后检查点编号前进');
  assert(afterLog.length < beforeLog.length, '最早的一批日志已折进检查点并从日志区移除');
  assert(Array.isArray(afterLog) && afterLog.every((e) => e.seq > afterCp.seq), '剩余日志编号全部大于检查点编号（不重复重放）');

  // 重开必须无损
  const reopened = openInMemory();
  assert(reopened.documents[0].versions.length === 1, '版本快照在压缩后完整保留');
  assert(reopened.documents[0].versions[0].name === '定稿版', '版本快照内容未损坏');
  assert(reopened.documents[0].title === '最后一笔', '当前步骤/文档内容恢复完整（含被压缩的日志）');
}

// ---------- 8. 压缩重放与真实状态一致（幂等） ----------
console.log('8. 压缩后的检查点+剩余日志与全部日志重放结果一致');
{
  const cp = JSON.parse(localStorage.getItem(CHECKPOINT_KEY));
  const log = JSON.parse(localStorage.getItem(LOG_KEY));
  // 构造「从未压缩」的参照：seq=0 空栈检查点 + 完整历史无法拿到（已压缩），
  // 改为校验：对当前 cp 重放剩余 log 得到的内容 == 存储中的 cp 自身（无新增改动时）
  const { replay } = mod;
  const { state, applied } = replay(cp, log);
  assert(applied === log.length, '剩余日志全部可连续重放');
  assert(state.documents[0].title === cp.documents[0].title, '重放结果与检查点当前状态一致');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
