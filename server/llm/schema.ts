/**
 * LLM 抽象层 — 结构化输出工具
 *
 * - JSONSchema：业务层统一使用的标准 JSON Schema 子集（小写 type）
 * - toGeminiSchema：转换为 Gemini responseSchema 方言（大写 type）
 * - extractJson / coerceToSchema / validateJson：屏蔽各家 JSON mode 差异，统一解析、纠正与校验
 *
 * 不引入 ajv 等第三方依赖：业务 Schema 只用到 type / properties / items / required / enum。
 */

export type JSONSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';

export interface JSONSchema {
  type: JSONSchemaType;
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: (string | number)[];
}

// ─── 方言转换 ─────────────────────────────────────────────────────

/** 标准 JSON Schema → Gemini responseSchema（OpenAPI 子集，type 大写） */
export function toGeminiSchema(schema: JSONSchema): Record<string, any> {
  const out: Record<string, any> = { type: schema.type.toUpperCase() };
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum.map(String);
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)])
    );
  }
  if (schema.required) out.required = [...schema.required];
  if (schema.items) out.items = toGeminiSchema(schema.items);
  return out;
}

// ─── 解析 ─────────────────────────────────────────────────────────

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * 从模型输出中提取 JSON。依次尝试：
 * 1. 直接解析
 * 2. 去掉 ```json 代码块围栏
 * 3. 截取最先出现的 { 或 [ 到与之对应的最后一个 } 或 ]
 * 都失败返回 undefined。
 */
export function extractJson(text: string): unknown {
  if (!text) return undefined;
  const trimmed = text.trim();

  const direct = tryParse(trimmed);
  if (direct.ok) return direct.value;

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const fenced = tryParse(fence[1].trim());
    if (fenced.ok) return fenced.value;
  }

  const firstObj = trimmed.indexOf('{');
  const firstArr = trimmed.indexOf('[');
  const candidates: Array<[string, string]> = [];
  // 先尝试最先出现的那种括号，避免把对象内部的数组误当成整体
  if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) {
    candidates.push(['{', '}'], ['[', ']']);
  } else {
    candidates.push(['[', ']'], ['{', '}']);
  }
  for (const [open, close] of candidates) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start >= 0 && end > start) {
      const sliced = tryParse(trimmed.slice(start, end + 1));
      if (sliced.ok) return sliced.value;
    }
  }
  return undefined;
}

/**
 * 纠正常见的形状偏差：
 * - 期望 object 却返回 array → 取第一个元素
 * - 期望 array 却返回 object → 包成单元素数组
 */
export function coerceToSchema(value: unknown, schema: JSONSchema): unknown {
  if (schema.type === 'object' && Array.isArray(value)) {
    return value.length > 0 ? value[0] : {};
  }
  if (schema.type === 'array' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return [value];
  }
  return value;
}

// ─── 校验 ─────────────────────────────────────────────────────────

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, type: JSONSchemaType): boolean {
  switch (type) {
    case 'object':  return typeOf(value) === 'object';
    case 'array':   return Array.isArray(value);
    case 'string':  return typeof value === 'string';
    case 'number':  return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
  }
}

/** 返回校验错误列表（路径 + 原因），空数组表示通过 */
export function validateJson(value: unknown, schema: JSONSchema, path = '$'): string[] {
  if (!matchesType(value, schema.type)) {
    return [`${path}: expected ${schema.type}, got ${typeOf(value)}`];
  }

  const errors: string[] = [];

  if (schema.enum && !schema.enum.includes(value as any)) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum`);
  }

  if (schema.type === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required || []) {
      if (obj[key] === undefined) errors.push(`${path}.${key}: required`);
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (obj[key] !== undefined && obj[key] !== null) {
        errors.push(...validateJson(obj[key], sub, `${path}.${key}`));
      }
    }
  }

  if (schema.type === 'array' && schema.items) {
    (value as unknown[]).forEach((item, i) => {
      errors.push(...validateJson(item, schema.items!, `${path}[${i}]`));
    });
  }

  return errors;
}
