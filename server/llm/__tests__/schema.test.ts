import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGeminiSchema, extractJson, coerceToSchema, validateJson, type JSONSchema } from '../schema';

const TECH: JSONSchema = {
  type: 'object',
  properties: {
    techName: { type: 'string' },
    problems: {
      type: 'array',
      items: { type: 'object', properties: { text: { type: 'string' }, timestamp: { type: 'string' } }, required: ['text', 'timestamp'] },
    },
    confidence: { type: 'number' },
  },
  required: ['techName', 'problems'],
};

test('toGeminiSchema 转大写方言并保留结构', () => {
  const g = toGeminiSchema(TECH);
  assert.equal(g.type, 'OBJECT');
  assert.equal(g.properties.problems.type, 'ARRAY');
  assert.equal(g.properties.problems.items.type, 'OBJECT');
  assert.equal(g.properties.problems.items.properties.text.type, 'STRING');
  assert.deepEqual(g.required, ['techName', 'problems']);
});

test('extractJson：直接 JSON / 代码块围栏 / 前后夹杂文字', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
  assert.deepEqual(extractJson('结果如下：{"a":1} 以上'), { a: 1 });
  assert.deepEqual(extractJson('[{"a":1}]'), [{ a: 1 }]);
  assert.equal(extractJson('not json'), undefined);
  assert.equal(extractJson(''), undefined);
});

test('extractJson：对象内含数组时不会误取内部数组', () => {
  const text = '说明文字 {"segments":[{"start":"00:01"}],"total":3} 结束';
  assert.deepEqual(extractJson(text), { segments: [{ start: '00:01' }], total: 3 });
});

test('coerceToSchema：数组↔对象纠正', () => {
  assert.deepEqual(coerceToSchema([{ a: 1 }, { a: 2 }], { type: 'object' }), { a: 1 });
  assert.deepEqual(coerceToSchema([], { type: 'object' }), {});
  assert.deepEqual(coerceToSchema({ a: 1 }, { type: 'array' }), [{ a: 1 }]);
  assert.deepEqual(coerceToSchema({ a: 1 }, { type: 'object' }), { a: 1 });
});

test('validateJson：通过 / 缺字段 / 类型错误 / 嵌套路径', () => {
  assert.deepEqual(validateJson({ techName: 'x', problems: [] }, TECH), []);

  const missing = validateJson({ problems: [] }, TECH);
  assert.deepEqual(missing, ['$.techName: required']);

  const wrongType = validateJson({ techName: 'x', problems: [{ text: 1, timestamp: '00:01' }], confidence: 'high' }, TECH);
  assert.ok(wrongType.includes('$.problems[0].text: expected string, got number'));
  assert.ok(wrongType.includes('$.confidence: expected number, got string'));

  assert.deepEqual(validateJson('x', { type: 'string', enum: ['a', 'b'] }), ['$: value "x" not in enum']);
});
