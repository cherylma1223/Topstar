import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadKnowledgeBase, getKnowledgeStore } from '../../knowledge/loader';
import { LOCKED_VIP_BLOCK, sanitizeAnswerTextForNonVip, stripVipSectionsFromKnowledge } from '../vipFilter';

const SECRET = '腰部预紧的弹簧效应-绝密正文';

before(() => {
  console.log = () => {};
  console.warn = () => {};
  loadKnowledgeBase();
});

// ─── 入模前剥离 ──────────────────────────────────────────────────

test('剥离各种标题写法：## / ### / # / 没有井号（线上知识库用的是 ##，旧正则一个都没匹配上）', () => {
  for (const heading of ['## 【核心秘诀】', '### 【核心秘诀】', '# 【核心秘诀】', '#### 【VIP专属内容】', '【核心秘诀】', '##【核心秘诀】']) {
    const doc = `## 【动作要领】\n站位要稳。\n\n${heading}\n${SECRET}`;
    const r = stripVipSectionsFromKnowledge(doc);
    assert.equal(r.hasVipSecret, true, heading);
    assert.ok(!r.content.includes(SECRET), `${heading} 的正文没有被剥离`);
    assert.ok(!r.content.includes('核心秘诀'), heading);
    assert.ok(r.content.includes('站位要稳'), `${heading} 误伤了其他章节`);
  }
});

test('秘诀章节后面还有别的章节：只剥离秘诀，不能把后面的内容一起吞掉', () => {
  const doc = `## 【动作要领】\n要领正文\n\n## 【核心秘诀】\n${SECRET}\n\n## 【常见问题】\n常见问题正文\n\n## 【训练建议】\n训练建议正文`;
  const r = stripVipSectionsFromKnowledge(doc);
  assert.ok(!r.content.includes(SECRET));
  for (const keep of ['要领正文', '常见问题正文', '训练建议正文']) assert.ok(r.content.includes(keep), `丢了：${keep}`);
});

test('没有秘诀的文档原样返回，hasVipSecret=false', () => {
  const doc = '## 【动作要领】\n站位要稳。\n\n## 【常见问题】\n没有秘诀。';
  assert.deepEqual(stripVipSectionsFromKnowledge(doc), { content: doc, hasVipSecret: false });
});

test('保守兜底：标题格式不认识（章节正则没覆盖到）时，从出现秘诀标记的那一行起截断，宁可少给也不放行', () => {
  const doc = `## 【动作要领】\n站位要稳。\n\n**核心秘诀**：${SECRET}\n\n## 【训练建议】\n训练建议正文`;
  const r = stripVipSectionsFromKnowledge(doc);
  assert.equal(r.hasVipSecret, true);
  assert.ok(!r.content.includes(SECRET));
  assert.ok(!r.content.includes('核心秘诀'));
  assert.ok(r.content.includes('站位要稳'));
});

// ─── 用真实知识库验证（这条测试本来就该有）──────────────────────────

test('真实知识库：每个含「核心秘诀」的文档，剥离后都不含秘诀正文和标记；不含秘诀的文档一字不改', () => {
  const store = getKnowledgeStore();
  assert.ok(store.size >= 10, `知识库没加载出来（${store.size}）`);

  let withSecret = 0;
  for (const [id, entry] of store) {
    const secret = entry.content.match(/【(?:核心秘诀|VIP专属)[^】]*】([\s\S]*?)(?=\n#{0,6}\s*【|$)/);
    const r = stripVipSectionsFromKnowledge(entry.content);

    if (secret) {
      withSecret++;
      const marker = secret[1].replace(/\s+/g, '').slice(0, 15);
      assert.ok(marker.length >= 6, `${id}：没取到秘诀正文`);
      assert.equal(r.hasVipSecret, true, `${id}`);
      assert.ok(!r.content.replace(/\s+/g, '').includes(marker), `${id}：秘诀正文没有被剥离`);
      assert.ok(!/核心秘诀|VIP专属/.test(r.content), `${id}：秘诀标记还在`);
      assert.ok(r.content.length > 100, `${id}：剥离后几乎没内容了，是不是误伤了（${r.content.length}）`);
    } else {
      assert.equal(r.content, entry.content, `${id}：没有秘诀的文档不应被改动`);
      assert.equal(r.hasVipSecret, false, id);
    }
  }
  assert.ok(withSecret >= 10, `含秘诀的文档只有 ${withSecret} 个，测试前提不成立`);
});

// ─── 出模后过滤（兜底防线，行为保持不变）──────────────────────────────

test('出模后过滤：删掉秘诀章节，并标记 removedVip', () => {
  const answer = `【动作要领】\n站位要稳。\n\n【核心秘诀】\n${SECRET}\n\n【训练建议】\n多练。`;
  const { text, removedVip } = sanitizeAnswerTextForNonVip(answer);
  assert.equal(removedVip, true);
  assert.ok(!text.includes(SECRET));
  assert.ok(text.includes('站位要稳') && text.includes('多练'));
});

test('出模后过滤：模型即使写成 ## 标题也能删掉；其他章节里夹带的泄露行也会删', () => {
  const a = sanitizeAnswerTextForNonVip(`【动作要领】\n要领\n\n## 【核心秘诀】\n${SECRET}`);
  assert.ok(!a.text.includes(SECRET));
  assert.equal(a.removedVip, true);

  const b = sanitizeAnswerTextForNonVip('【训练建议】\n多练基本功。\n这是二次点火的诀窍。\n坚持练习。');
  assert.equal(b.removedVip, true);
  assert.ok(!b.text.includes('二次点火'));
  assert.ok(b.text.includes('多练基本功') && b.text.includes('坚持练习'));
});

test('出模后过滤：没有秘诀的正常回答原样保留', () => {
  const answer = '【动作要领】\n站位要稳。\n\n【训练建议】\n多练。';
  assert.deepEqual(sanitizeAnswerTextForNonVip(answer), { text: answer, removedVip: false });
});

test('锁定占位文案没有变（前端依赖 [LOCKED_VIP_CONTENT] 渲染锁定样式）', () => {
  assert.equal(LOCKED_VIP_BLOCK, '【核心秘诀】\n[LOCKED_VIP_CONTENT]');
});
