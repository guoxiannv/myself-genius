import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const RUN_STATE_FILE = '.expo-fast/state.json';

const stateMetadata = {
  generating_code: { label: '生成代码', status: 'running' },
  repairing: { label: '修复', status: 'running' },
  completed: { label: '完成', status: 'passed' },
  failed: { label: '失败', status: 'failed' },
};

const detailLabels = {
  preparing: '准备模板与能力索引',
  model_generation: '生成代码',
  follow_up: 'Agent 正在续跑调整',
  follow_up_failed: '续跑调整失败，上一版本仍可使用',
  follow_up_interrupted: '续跑调整已中断，上一版本仍可使用',
  rebuild: '重新验证并构建现有版本',
  preview: '重新发布并启动预览',
  verification: '验证生成结果',
  model_repair: '修复代码',
  repair_verification: '验证修复结果',
  launching: '启动并检查应用',
  preview_queued: '等待空闲的桌面和手机模拟器',
  preview_failed: '预览失败，生成产物仍然可用',
  hap_building: '构建 unsigned HAP',
  done: '完成',
  error: '失败',
};

function readPrevious(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function definedEntries(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, entry]) => entry !== undefined));
}

export function writeRunState(projectRoot, state, options = {}) {
  const metadata = stateMetadata[state];
  if (!metadata) throw new Error(`unknown Expo Fast run state: ${state}`);

  const project = resolve(projectRoot);
  const path = join(project, RUN_STATE_FILE);
  const previous = options.reset ? null : readPrevious(path);
  const runId = options.runId || previous?.runId || randomUUID();
  const sameRun = previous?.runId === runId;
  const now = new Date().toISOString();
  const detail = options.detail || '';
  const detailLabel = detailLabels[detail] || detail;
  const context = definedEntries({ ...(sameRun ? previous.context : {}), ...options.context });
  const history = sameRun && Array.isArray(previous.history) ? [...previous.history] : [];
  history.push({ state, label: metadata.label, status: metadata.status, detail, detailLabel, at: now });

  const next = {
    schemaVersion: 1,
    runId,
    project,
    pid: process.pid,
    state,
    label: metadata.label,
    status: metadata.status,
    detail,
    detailLabel,
    startedAt: sameRun ? previous.startedAt : (options.startedAt || now),
    updatedAt: now,
    context,
    history,
  };
  if (options.error) next.error = String(options.error).slice(0, 4000);

  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(temporaryPath, path);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
  return next;
}
