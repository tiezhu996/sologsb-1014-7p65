/**
 * ProofStore 集成验证：在最小浏览器环境垫片里加载真实 store.ts，
 * 验证「编辑追加日志 → 页面崩溃（重建 store）→ 检查点+重放恢复撤销栈」。
 */
import { build } from 'vite';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outDir = mkdtempSync(join(tmpdir(), 'store-test-'));

// store.ts 依赖 mithril，需要最小浏览器垫片
const storeMap = new Map();
globalThis.localStorage = {
  getItem: (k) => storeMap.get(k) ?? null,
  setItem: (k, v) => storeMap.set(k, String(v)),
  removeItem: (k) => storeMap.delete(k),
  clear: () => storeMap.clear(),
};
globalThis.structuredClone = (v) => JSON.parse(JSON.stringify(v));
const timers = [];
globalThis.window = {
  setTimeout: (fn) => { timers.push(fn); return timers.length; },
  clearTimeout: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.document = undefined;

await build({
  logLevel: 'silent',
  configFile: false,
  build: {
    lib: { entry: 'src/store.ts', formats: ['es'], fileName: 'store' },
    outDir, emptyOutDir: false, minify: false,
  },
});

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

let storeNonce = 0;
async function newStore() {
  // ESM 模块有缓存，每次「重开页面」都复制一份产物到唯一文件重新导入
  const dir = join(outDir, `boot-${(storeNonce += 1)}`);
  const fs = await import('node:fs');
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(outDir)) {
    if (file.endsWith('.js')) copyFileSync(join(outDir, file), join(dir, file));
  }
  const mod = await import(pathToFileURL(join(dir, 'store.js')).href);
  return new mod.ProofStore();
}

// 首次打开（全新浏览器）
localStorage.clear();
let store = await newStore();
console.log('1. 编辑过程中崩溃，重开页面');
assert(store.documents.length === 2, '首次打开加载示例文档');
assert(store.undoStack.length === 0, '新工作区撤销栈为空');

// 连续三次编辑（不触发稳定折叠，折叠计时器在垫片里不自动执行）
store.selectDocument(store.documents[0].id);
store.update((doc) => { doc.title = '我的新证明'; });
store.selectStep(store.documents[0].steps[0].id);
store.updateStep({ statement: '$a,b,c$ 是实数' });
store.addStep('derivation');
const stepsAfterEdit = store.documents[0].steps.length;
assert(store.undoStack.length === 3, '内存撤销栈有三层');
const checkpointSeq = JSON.parse(localStorage.getItem('sologsb-1014-checkpoint-v2')).seq;
const logLen = JSON.parse(localStorage.getItem('sologsb-1014-editlog-v2')).length;
assert(checkpointSeq === 0, '改动尚未稳定合并，检查点停在初始');
assert(logLen === 3, '三条改动按编号追加在编辑日志');

// 页面崩溃：丢弃内存中的 store，模拟重新打开
let reopened = await newStore();
assert(reopened.current.title === '我的新证明', '重开后先读检查点再重放日志，文档恢复');
assert(reopened.current.steps.some((s) => s.statement === '$a,b,c$ 是实数'), '步骤改动通过重放恢复');
assert(reopened.current.steps.length === stepsAfterEdit, '新增步骤通过重放恢复');
assert(reopened.undoStack.length === 3, '撤销栈随重放恢复（崩溃不再丢失撤销历史）');
assert(reopened.redoStack.length === 0, '重做栈为空');

console.log('2. 重开后撤销，再崩溃，再重开');
reopened.undo();
assert(reopened.undoStack.length === 2 && reopened.redoStack.length === 1, '撤销后内存栈状态正确');
reopened = await newStore();
assert(reopened.undoStack.length === 2 && reopened.redoStack.length === 1, '撤销操作本身也写日志，再次重开栈状态保持');
reopened.redo();
assert(reopened.undoStack.length === 3 && reopened.redoStack.length === 0, '重做后栈恢复');

console.log('3. Ctrl+S 立即合并检查点');
reopened.save();
assert(JSON.parse(localStorage.getItem('sologsb-1014-editlog-v2')).length === 0, '保存后日志合并清空');
const cpAfterSave = JSON.parse(localStorage.getItem('sologsb-1014-checkpoint-v2'));
assert(cpAfterSave.seq === 5 && cpAfterSave.documents[0].title === '我的新证明', '检查点包含最新内容与编号（3 编辑 + 1 撤销 + 1 重做）');
reopened = await newStore();
assert(reopened.current.title === '我的新证明', '从检查点直接恢复');
assert(reopened.undoStack.length === 3, '撤销栈随检查点完整保留');

console.log('4. 版本快照在编辑日志/检查点往返中完整');
reopened.createVersion();
reopened.save();
reopened = await newStore();
assert(reopened.current.versions.length === 1, '版本快照随检查点保留');
assert(reopened.current.versions[0].steps.length > 0, '版本内的步骤快照完整');

console.log('5. 旧稿迁移');
localStorage.clear();
const legacy = [{
  id: 'old-doc', title: '旧版稿件', author: '往届学生', goal: '$X=Y$',
  symbols: { X: '对象' },
  steps: [{ id: 'x1', type: 'premise', statement: '$X$ 存在', rule: '前提', references: [], note: '', counterexample: '', alternative: '' }],
  versions: [], updatedAt: new Date().toISOString(),
}];
localStorage.setItem('sologsb-1014-proof-workspace-v1', JSON.stringify(legacy));
store = await newStore();
assert(store.current.title === '旧版稿件', '旧稿打开时内容迁移');
assert(JSON.parse(localStorage.getItem('sologsb-1014-checkpoint-v2')).format === 2, '旧稿迁移为 v2 检查点');
assert(store.undoStack.length === 0, '迁移稿没有可恢复的撤销历史');
store.update((doc) => { doc.title = '迁移后继续编辑'; });
reopened = await newStore();
assert(reopened.current.title === '迁移后继续编辑', '迁移后的改动照常走日志重放');

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
