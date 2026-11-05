/**
 * Gemini SDK 客户端（懒加载单例）
 *
 * 全项目唯一允许 `import '@google/genai'` 的目录是 `server/llm/gemini/`。
 * 业务代码请通过 `server/llm` 的抽象层调用模型，不要直接使用本文件。
 *
 * 参考：docs/arch/Topstar_国产化模型迁移计划_v2.md §4.2 Phase 0.1
 */
import { GoogleGenAI } from '@google/genai';

let ai: GoogleGenAI | null = null;

export function getAI(): GoogleGenAI {
  if (!ai) {
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
  }
  return ai;
}

export function hasGeminiKey(): boolean {
  return !!process.env.GEMINI_API_KEY;
}
