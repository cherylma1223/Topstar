/**
 * 阿里云短信通道测试（假 fetch，不发真短信）
 *
 * 重点保护三件事：签名算法别写错、失败信息能照着排查、密钥不会漏进日志或请求体以外的地方。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  AliyunSmsError,
  AliyunSmsSender,
  buildSendSmsParams,
  buildQuerySendDetailsParams,
  buildStringToSign,
  canonicalize,
  explainReceiptError,
  parseSendDetails,
  querySendDetails,
  explainErrorCode,
  formatTimestamp,
  percentEncode,
  readAliyunSmsConfig,
  signRequest,
} from '../aliyunSms';
import { DryRunSmsSender, createSmsSender, isSmsDryRun } from '../sms';

const ENV = {
  SMS_PROVIDER: 'aliyun',
  /** 显式关掉演练，测真实通道 */
  SMS_DRY_RUN: '0',
  ALIYUN_SMS_ACCESS_KEY_ID: 'test-key-id',
  ALIYUN_SMS_ACCESS_KEY_SECRET: 'test-key-secret',
  ALIYUN_SMS_SIGN_NAME: '当家球星',
  ALIYUN_SMS_TEMPLATE_CODE: 'SMS_123456789',
};

const FIXED_DATE = new Date('2026-11-09T06:00:00.000Z');

function fakeFetch(reply: { status?: number; body?: string }) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: String(init?.body ?? ''), headers: init?.headers ?? {} });
    const status = reply.status ?? 200;
    return new Response(reply.body ?? '{"Code":"OK","Message":"OK","RequestId":"req-1","BizId":"biz-1"}', {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function makeSender(reply: { status?: number; body?: string } = {}) {
  const fake = fakeFetch(reply);
  const sender = new AliyunSmsSender(
    readAliyunSmsConfig(ENV),
    fake.impl,
    () => FIXED_DATE,
    () => 'fixed-nonce',
  );
  return { sender, calls: fake.calls };
}

// ─── 编码与签名 ──────────────────────────────────────────────────────────────

test('percentEncode：空格、加号、中文、以及 encodeURIComponent 放过的字符都编码', () => {
  assert.equal(percentEncode('a b'), 'a%20b');
  assert.equal(percentEncode('a+b'), 'a%2Bb');
  assert.equal(percentEncode("!'()*"), '%21%27%28%29%2A');
  assert.equal(percentEncode('～~'), '%EF%BD%9E~'); // ~ 不编码，全角字符照常编码
});

test('canonicalize：参数按 key 字典序排列', () => {
  const qs = canonicalize({ b: '2', a: '1', C: '3' });
  assert.equal(qs, 'C=3&a=1&b=2');
});

test('官方文档示例对拍：AccessKeySecret + "&" 作 HMAC key，得出文档里那个签名', () => {
  // 阿里云「请求签名」文档的 ECS DescribeRegions 示例（testid / testsecret）
  const params = {
    AccessKeyId: 'testid',
    Action: 'DescribeRegions',
    Format: 'XML',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: '3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf',
    SignatureVersion: '1.0',
    Timestamp: '2016-02-23T12:46:24Z',
    Version: '2014-05-26',
  };
  assert.equal(buildStringToSign(params, 'GET'), 'GET&%2F&' + percentEncode(canonicalize(params)));
  assert.equal(signRequest(params, 'testsecret', 'GET'), 'OLeaidS1JvxuMvnyHOwuJ+uX5qY=');
});

test('signRequest：等于独立计算的 Base64(HMAC-SHA1(secret + "&", "POST&%2F&" + 编码后的待签名串))', () => {
  const params = buildSendSmsParams({
    accessKeyId: 'test-key-id',
    phone: '13800138000',
    code: '123456',
    signName: '当家球星',
    templateCode: 'SMS_123456789',
    regionId: 'cn-hangzhou',
    templateParamName: 'code',
    nonce: 'fixed-nonce',
    timestamp: '2026-11-09T06:00:00Z',
  });
  const stringToSign = `POST&${encodeURIComponent('/')}&${percentEncode(canonicalize(params))}`;
  const expected = createHmac('sha1', 'test-key-secret&').update(stringToSign, 'utf8').digest('base64');
  assert.equal(signRequest(params, 'test-key-secret'), expected);
  assert.match(stringToSign, /^POST&%2F&/);
  assert.ok(stringToSign.includes('Action%3DSendSms')); // 已编码
});

test('buildSendSmsParams：接口版本、模板参数、手机号都对，且不含密钥', () => {
  const params = buildSendSmsParams({
    accessKeyId: 'test-key-id',
    phone: '13800138000',
    code: '654321',
    signName: '当家球星',
    templateCode: 'SMS_123456789',
    regionId: 'cn-hangzhou',
    templateParamName: 'code',
    nonce: 'n',
    timestamp: '2026-11-09T06:00:00Z',
  });
  assert.equal(params.Action, 'SendSms');
  assert.equal(params.Version, '2017-05-25');
  assert.equal(params.PhoneNumbers, '13800138000');
  assert.equal(params.SignName, '当家球星');
  assert.equal(params.TemplateCode, 'SMS_123456789');
  assert.equal(params.TemplateParam, '{"code":"654321"}');
  assert.equal(params.SignatureMethod, 'HMAC-SHA1');
  assert.deepEqual(Object.keys(params).filter((k) => /secret/i.test(k)), []);
});

test('formatTimestamp：去掉毫秒，保持 UTC 的 Z 结尾', () => {
  assert.equal(formatTimestamp(FIXED_DATE), '2026-11-09T06:00:00Z');
});

// ─── 发送成功 / 失败 ────────────────────────────────────────────────────────

test('发送成功：请求带上签名、手机号和模板变量，返回结果不抛错', async () => {
  const { sender, calls } = makeSender();
  await sender.sendLoginCode('13800138000', '123456');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://dysmsapi.aliyuncs.com/');
  assert.match(calls[0].headers['content-type'], /x-www-form-urlencoded/);
  assert.ok(calls[0].body.includes('PhoneNumbers=13800138000'));
  assert.ok(calls[0].body.includes('Signature='));
  assert.ok(calls[0].body.includes('TemplateParam=%7B%22code%22%3A%22123456%22%7D'));
  // 密钥只参与签名计算，不出现在请求里
  assert.ok(!calls[0].body.includes('test-key-secret'));
  assert.ok(!calls[0].url.includes('test-key-secret'));
});

test('业务失败（限流）：抛 AliyunSmsError，错误码保留，提示里带排查建议', async () => {
  const { sender } = makeSender({
    body: '{"Code":"isv.BUSINESS_LIMIT_CONTROL","Message":"触发号码天级流控","RequestId":"req-2"}',
  });
  await assert.rejects(
    () => sender.sendLoginCode('13800138000', '123456'),
    (err: any) => {
      assert.ok(err instanceof AliyunSmsError);
      assert.equal(err.providerCode, 'isv.BUSINESS_LIMIT_CONTROL');
      assert.equal(err.requestId, 'req-2');
      assert.match(err.message, /限流/);
      assert.match(err.message, /138\*\*\*\*8000/); // 日志里是脱敏号码
      assert.ok(!err.message.includes('13800138000'));
      return true;
    },
  );
});

test('鉴权失败（密钥填错）：错误码翻译成「检查 Secret」', async () => {
  const { sender } = makeSender({ body: '{"Code":"SignatureDoesNotMatch","Message":"Specified signature is not matched"}' });
  await assert.rejects(() => sender.sendLoginCode('13800138000', '123456'), /ALIYUN_SMS_ACCESS_KEY_SECRET/);
});

test('HTTP 5xx 且响应不是 JSON：用 HTTP_500 作为错误码，不吞掉', async () => {
  const { sender } = makeSender({ status: 502, body: 'Bad Gateway' });
  await assert.rejects(
    () => sender.sendLoginCode('13800138000', '123456'),
    (err: any) => {
      assert.equal(err.providerCode, 'HTTP_502');
      assert.match(err.message, /Bad Gateway/);
      return true;
    },
  );
});

test('网络异常：包装成 NETWORK_ERROR，不泄露 AccessKey', async () => {
  const config = readAliyunSmsConfig(ENV);
  const sender = new AliyunSmsSender(
    config,
    (async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch,
    () => FIXED_DATE,
    () => 'fixed-nonce',
  );
  await assert.rejects(
    () => sender.sendLoginCode('13800138000', '123456'),
    (err: any) => {
      assert.equal(err.providerCode, 'NETWORK_ERROR');
      assert.match(err.message, /fetch failed/);
      assert.ok(!err.message.includes(config.accessKeySecret));
      return true;
    },
  );
});

test('explainErrorCode：已知码给中文建议，未知码保留原始 Code 和 Message', () => {
  assert.match(explainErrorCode('isv.SMS_TEMPLATE_ILLEGAL'), /模板/);
  assert.match(explainErrorCode('Forbidden.RAM'), /dysms:SendSms/);
  assert.equal(explainErrorCode('Something.New', '陌生错误'), '阿里云返回 Something.New：陌生错误');
});


// ─── 回执查询 ──────────────────────────────────────────────────────────────

test('buildQuerySendDetailsParams：Action / SendDate / 分页参数都对', () => {
  const params = buildQuerySendDetailsParams({
    accessKeyId: 'test-key-id',
    phone: '13800138000',
    sendDate: '20261109',
    regionId: 'cn-hangzhou',
    nonce: 'n',
    timestamp: '2026-11-09T06:00:00Z',
  });
  assert.equal(params.Action, 'QuerySendDetails');
  assert.equal(params.SendDate, '20261109');
  assert.equal(params.PhoneNumber, '13800138000');
  assert.equal(params.Version, '2017-05-25');
  assert.equal(params.PageSize, '10');
  assert.equal(params.CurrentPage, '1');
});

test('parseSendDetails：原始大写键和 SDK 转小写键都能解析，状态映射正确', () => {
  const raw = {
    Code: 'OK',
    SmsSendDetailDTOs: {
      SmsSendDetailDTO: [
        { PhoneNum: '138****0000', Content: '【签名】验证码 123456', SendStatus: 2, ErrCode: 'PORT_NOT_REGISTERED', SendDate: '2026-11-09 16:24:03', ReceiveDate: '2026-11-09 16:24:17', TemplateCode: 'SMS_1' },
        { PhoneNum: '138****0000', Content: 'x', SendStatus: 3, SendDate: '2026-11-09 16:25:00', TemplateCode: 'SMS_1' },
        { PhoneNum: '138****0000', Content: 'y', SendStatus: 1, SendDate: '2026-11-09 16:26:00', TemplateCode: 'SMS_1' },
      ],
    },
  };
  const [failed, ok, pending] = parseSendDetails(raw as any);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.statusText, '发送失败');
  assert.equal(failed.errCode, 'PORT_NOT_REGISTERED');
  assert.match(failed.errText || '', /端口/);
  assert.equal(failed.receiveDate, '2026-11-09 16:24:17');
  assert.equal(ok.status, 'success');
  assert.equal(ok.errCode, undefined);
  assert.equal(pending.status, 'pending');

  const lower = parseSendDetails({ smsSendDetailDTOs: { smsSendDetailDTO: [{ phoneNum: '138****0000', sendStatus: 3, content: 'z', templateCode: 'SMS_1', sendDate: 'd' }] } } as any);
  assert.equal(lower[0].status, 'success');
  assert.equal(parseSendDetails({ Code: 'OK' } as any).length, 0);
});

test('explainReceiptError：PORT_NOT_REGISTERED 提示指向签名/通道审核与号码无效，未知码保留原文', () => {
  assert.match(explainReceiptError('PORT_NOT_REGISTERED'), /签名 \/ 短信通道/);
  assert.equal(explainReceiptError('WHATEVER_123'), '运营商回执错误码 WHATEVER_123');
});

test('querySendDetails：签名并请求 QuerySendDetails，返回解析后的记录', async () => {
  const calls: { body: string }[] = [];
  const fetchImpl = (async (_url: any, init: any) => {
    calls.push({ body: String(init?.body ?? '') });
    return new Response(JSON.stringify({
      Code: 'OK',
      RequestId: 'req-9',
      SmsSendDetailDTOs: { SmsSendDetailDTO: [{ PhoneNum: '138****0000', Content: 'c', SendStatus: 3, SendDate: 'd', TemplateCode: 'SMS_1' }] },
    }), { status: 200 });
  }) as unknown as typeof fetch;

  const records = await querySendDetails(
    readAliyunSmsConfig(ENV),
    { phone: '13800138000', sendDate: '20261109' },
    { fetchImpl, clock: () => FIXED_DATE, nonce: () => 'fixed-nonce' },
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'success');
  assert.ok(calls[0].body.includes('Action=QuerySendDetails'));
  assert.ok(calls[0].body.includes('SendDate=20261109'));
  assert.ok(calls[0].body.includes('Signature='));
});

test('querySendDetails：业务失败（签名错）抛 AliyunSmsError', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ Code: 'SignatureDoesNotMatch', Message: 'no' }), { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(
    () => querySendDetails(readAliyunSmsConfig(ENV), { phone: '13800138000', sendDate: '20261109' }, { fetchImpl }),
    (err: any) => err instanceof AliyunSmsError && err.providerCode === 'SignatureDoesNotMatch',
  );
});

// ─── 配置与工厂 ────────────────────────────────────────────────────────────

test('readAliyunSmsConfig：缺变量时一次性列出全部缺失项', () => {
  assert.throws(
    () => readAliyunSmsConfig({ SMS_PROVIDER: 'aliyun' }),
    (err: any) => {
      assert.match(err.message, /ALIYUN_SMS_ACCESS_KEY_ID/);
      assert.match(err.message, /ALIYUN_SMS_ACCESS_KEY_SECRET/);
      assert.match(err.message, /ALIYUN_SMS_SIGN_NAME/);
      assert.match(err.message, /ALIYUN_SMS_TEMPLATE_CODE/);
      return true;
    },
  );
});

test('readAliyunSmsConfig：模板 CODE 格式不对直接报错，默认值可被覆盖', () => {
  assert.throws(
    () => readAliyunSmsConfig({ ...ENV, ALIYUN_SMS_TEMPLATE_CODE: '123456789' }),
    /SMS_123456789/,
  );
  const config = readAliyunSmsConfig(ENV);
  assert.equal(config.regionId, 'cn-hangzhou');
  assert.equal(config.templateParamName, 'code');
  assert.equal(config.endpoint, 'https://dysmsapi.aliyuncs.com/');

  const custom = readAliyunSmsConfig({
    ...ENV,
    ALIYUN_SMS_REGION_ID: 'cn-beijing',
    ALIYUN_SMS_TEMPLATE_PARAM: 'verifyCode',
  });
  assert.equal(custom.regionId, 'cn-beijing');
  assert.equal(custom.templateParamName, 'verifyCode');
});

test('isSmsDryRun：开发默认演练、生产默认真发，显式值优先', () => {
  assert.equal(isSmsDryRun({}), true); // 开发（NODE_ENV 未设置）默认演练
  assert.equal(isSmsDryRun({ NODE_ENV: 'development' }), true);
  assert.equal(isSmsDryRun({ NODE_ENV: 'production' }), false);
  assert.equal(isSmsDryRun({ SMS_DRY_RUN: '0' }), false);
  assert.equal(isSmsDryRun({ SMS_DRY_RUN: 'off' }), false);
  assert.equal(isSmsDryRun({ SMS_DRY_RUN: '1' }), true);
  assert.equal(isSmsDryRun({ SMS_DRY_RUN: 'TRUE', NODE_ENV: 'production' }), true);
  assert.equal(isSmsDryRun({ SMS_DRY_RUN: '随便写的' }), true); // 认不出的值按默认
});

test('createSmsSender：开发环境默认返回演练通道，且真的不调用外部接口', async () => {
  const sender = createSmsSender({ ...ENV, SMS_DRY_RUN: undefined } as any);
  assert.equal(sender.name, 'aliyun-dry-run');
  assert.ok(sender instanceof DryRunSmsSender);

  const original = globalThis.fetch;
  let called = 0;
  (globalThis as any).fetch = async () => {
    called += 1;
    throw new Error('演练模式不应该发请求');
  };
  try {
    await sender.sendLoginCode('13800138000', '123456');
  } finally {
    (globalThis as any).fetch = original;
  }
  assert.equal(called, 0);
});

test('createSmsSender：生产环境必须真发，配了 SMS_DRY_RUN 会拒绝启动', () => {
  const prod = { ...ENV, NODE_ENV: 'production', SMS_DRY_RUN: undefined } as any;
  assert.equal(createSmsSender(prod).name, 'aliyun'); // 生产默认走真实通道
  assert.throws(() => createSmsSender({ ...prod, SMS_DRY_RUN: '1' }), /SMS_DRY_RUN/);
});

test('createSmsSender：aliyun 返回真实通道，console 仍可用，未配置时报错', () => {
  const sender = createSmsSender(ENV);
  assert.equal(sender.name, 'aliyun');
  assert.equal(createSmsSender({}).name, 'console');
  assert.throws(() => createSmsSender({ NODE_ENV: 'production' }), /SMS_PROVIDER/);
  assert.throws(() => createSmsSender({ NODE_ENV: 'production', SMS_PROVIDER: 'console' }), /生产环境不能使用/);
  assert.throws(() => createSmsSender({ SMS_PROVIDER: 'tencent' }), /可选 console \/ aliyun/);
});
