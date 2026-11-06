/**
 * 评测指标：纯函数，不依赖模型、数据库或文件系统，可以单测
 */
import type { Interval } from './annotations';

// ─── 基础统计 ────────────────────────────────────────────────────

export function mean(values: number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** 分位数（线性插值）。样本很少时 P95 ≈ 最大值，报告里会注明样本数 */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const pos = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ─── 片段（Pass 1）───────────────────────────────────────────────

function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter(i => i.end > i.start).map(i => ({ ...i })).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push(i);
  }
  return out;
}

const total = (list: Interval[]) => sum(list.map(i => i.end - i.start));

function overlap(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** 时间轴上的交并比：预测片段与标注片段重叠的总时长 / 两者覆盖的总时长。两边都为空视为完全一致（1） */
export function intervalsIoU(pred: Interval[], gold: Interval[]): number {
  const p = mergeIntervals(pred);
  const g = mergeIntervals(gold);
  if (p.length === 0 && g.length === 0) return 1;

  let inter = 0;
  for (const a of p) for (const b of g) inter += overlap(a, b);
  const union = total(p) + total(g) - inter;
  return union === 0 ? 1 : inter / union;
}

export interface BoundaryErrors {
  /** 每个被匹配上的标注片段的起 / 止时间误差（秒，预测 - 标注，带符号） */
  startErrors: number[];
  endErrors: number[];
  /** 没有任何预测片段与之重叠的标注片段数（漏检） */
  missedGold: number;
  /** 没有与任何标注片段重叠的预测片段数（多检） */
  extraPred: number;
}

/** 每个标注片段匹配与之重叠最多的预测片段，统计边界误差、漏检、多检 */
export function boundaryErrors(pred: Interval[], gold: Interval[]): BoundaryErrors {
  const p = mergeIntervals(pred);
  const g = mergeIntervals(gold);
  const result: BoundaryErrors = { startErrors: [], endErrors: [], missedGold: 0, extraPred: 0 };

  for (const gi of g) {
    let best: Interval | undefined;
    let bestOverlap = 0;
    for (const pi of p) {
      const o = overlap(gi, pi);
      if (o > bestOverlap) { bestOverlap = o; best = pi; }
    }
    if (best) {
      result.startErrors.push(best.start - gi.start);
      result.endErrors.push(best.end - gi.end);
    } else {
      result.missedGold++;
    }
  }
  result.extraPred = p.filter(pi => !g.some(gi => overlap(gi, pi) > 0)).length;
  return result;
}

/** 解析 Pass 1 原始输出里的 `mm:ss` / `hh:mm:ss` 片段；非法的跳过 */
export function parsePredictedSegments(segments: unknown): Interval[] {
  if (!Array.isArray(segments)) return [];
  const toSec = (v: unknown): number | null => {
    const parts = String(v ?? '').split(':').map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some(n => !Number.isFinite(n))) return null;
    return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
  };
  const out: Interval[] = [];
  for (const s of segments) {
    const start = toSec((s as any)?.start);
    const end = toSec((s as any)?.end);
    if (start !== null && end !== null && end > start) out.push({ start, end });
  }
  return out;
}

// ─── 问题点（Pass 2）─────────────────────────────────────────────

const normalizeText = (s: string) => s.replace(/[\s，。,.;；:：！!？?、"“”'‘’（）()【】\[\]]/g, '');

export interface RuleLite { issue_id: string; problem: string; evidence: string }

/**
 * 把模型输出的问题描述对应回诊断规则：只要描述里包含某条规则的「视觉证据」或「问题」原文，
 * 就算命中该规则。没有命中任何规则的描述归为 unmatched（模型自由发挥的观察）。
 *
 * 局限：Pass 2 的 prompt 要求优先匹配规则，所以模型多数会照抄规则原文，这个方法对此有效；
 * 如果换了模型后喜欢改写措辞，会被低估召回——到时再引入 LLM-as-judge。
 */
export function matchProblemsToRules(problemTexts: string[], rules: RuleLite[]): { matched: string[]; unmatched: string[] } {
  const matched = new Set<string>();
  const unmatched: string[] = [];

  for (const text of problemTexts) {
    const n = normalizeText(text);
    let hit = false;
    for (const r of rules) {
      const ev = normalizeText(r.evidence || '');
      const pr = normalizeText(r.problem || '');
      if ((ev && n.includes(ev)) || (pr && n.includes(pr))) { matched.add(r.issue_id); hit = true; }
    }
    if (!hit) unmatched.push(text);
  }
  return { matched: [...matched], unmatched };
}

export interface PRF { precision?: number; recall?: number; f1?: number }

export function precisionRecallF1(predicted: string[], gold: string[]): PRF {
  const p = new Set(predicted);
  const g = new Set(gold);
  const tp = [...p].filter(x => g.has(x)).length;
  const precision = p.size === 0 ? undefined : tp / p.size;
  const recall = g.size === 0 ? undefined : tp / g.size;
  const f1 = precision !== undefined && recall !== undefined && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : (precision === 0 || recall === 0 ? 0 : undefined);
  return { precision, recall, f1 };
}

// ─── 稳定性 ──────────────────────────────────────────────────────

/** 多次重复里出现最多的那个结果所占的比例；1 = 每次都一样 */
export function agreement(labels: string[]): number | undefined {
  if (labels.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return Math.max(...counts.values()) / labels.length;
}
