/**
 * 阿里云短信通道（SendSms OpenAPI，RPC 风格 + HMAC-SHA1 签名）
 *
 * 不引官方 SDK：只用一个接口，签名算法固定且不长，自己实现少一个依赖，也方便单测
 * （官方文档：dysmsapi 2017-05-25 SendSms）。
 *
 * 需要的环境变量（缺哪个就报哪个，启动即失败，不会带着空配置跑起来）：
 *   ALIYUN_SMS_ACCESS_KEY_ID      AccessKey ID（建议 RAM 子账号，只授权 dysms:SendSms）
 *   ALIYUN_SMS_ACCESS_KEY_SECRET  AccessKey Secret
 *   ALIYUN_SMS_SIGN_NAME          短信签名，如「当家球星」
 *   ALIYUN_SMS_TEMPLATE_CODE      验证码模板 CODE，如 SMS_123456789
 * 可选：
 *   ALIYUN_SMS_REGION_ID          默认 cn-hangzhou（短信服务不分地域，跟着控制台默认即可）
 *   ALIYUN_SMS_TEMPLATE_PARAM     模板变量名，默认 code（模板「您的验证码是 ${code}」就是 code）
 *   ALIYUN_SMS_ENDPOINT           默认 https://dysmsapi.aliyuncs.com/（测试可指向假服务）
 */
import { createHmac, randomUUID } from 'node:crypto';
import { maskPhone } from './phone';
import type { SmsSender } from './sms';

const API_ACTION = 'SendSms';
const API_VERSION = '2017-05-25';
const DEFAULT_REGION_ID = 'cn-hangzhou';
const DEFAULT_ENDPOINT = 'https://dysmsapi.aliyuncs.com/';
const DEFAULT_TEMPLATE_PARAM = 'code';
const REQUEST_TIMEOUT_MS = 10_000;

type Env = Record<string, string | undefined>;

export interface AliyunSmsConfig {
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
  templateCode: string;
  regionId: string;
  templateParamName: string;
  endpoint: string;
}

/** 从环境变量读取配置；缺项时一次性列出所有缺失的变量名 */
export function readAliyunSmsConfig(env: Env = process.env): AliyunSmsConfig {
  const required: [key: string, what: string][] = [
    ['ALIYUN_SMS_ACCESS_KEY_ID', 'AccessKey ID'],
    ['ALIYUN_SMS_ACCESS_KEY_SECRET', 'AccessKey Secret'],
    ['ALIYUN_SMS_SIGN_NAME', '短信签名'],
    ['ALIYUN_SMS_TEMPLATE_CODE', '验证码模板 CODE'],
  ];
  const missing = required.filter(([key]) => !(env[key] || '').trim());
  if (missing.length) {
    throw new Error(
      '阿里云短信配置不完整，缺少环境变量：' +
      missing.map(([key, what]) => `${key}（${what}）`).join('、'),
    );
  }
  const templateCode = (env.ALIYUN_SMS_TEMPLATE_CODE || '').trim();
  if (!/^SMS_\d+$/.test(templateCode)) {
    throw new Error(`ALIYUN_SMS_TEMPLATE_CODE 格式不对，应形如 SMS_123456789，当前值「${templateCode}」`);
  }
  return {
    accessKeyId: (env.ALIYUN_SMS_ACCESS_KEY_ID || '').trim(),
    accessKeySecret: (env.ALIYUN_SMS_ACCESS_KEY_SECRET || '').trim(),
    signName: (env.ALIYUN_SMS_SIGN_NAME || '').trim(),
    templateCode,
    regionId: (env.ALIYUN_SMS_REGION_ID || '').trim() || DEFAULT_REGION_ID,
    templateParamName: (env.ALIYUN_SMS_TEMPLATE_PARAM || '').trim() || DEFAULT_TEMPLATE_PARAM,
    endpoint: (env.ALIYUN_SMS_ENDPOINT || '').trim() || DEFAULT_ENDPOINT,
  };
}

/**
 * 阿里云的百分比编码：先 encodeURIComponent，再把它放过的 `!'()*` 也编码掉
 * （encodeURIComponent 与 RFC3986 的差异只在这几个字符上）
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** 按 key 字典序拼成待签名串 */
export function canonicalize(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');
}

/**
 * RPC（V1）签名：StringToSign = METHOD & percentEncode("/") & percentEncode(canonicalize(params))
 *
 * 注意 HMAC 的 key 是 `AccessKeySecret + "&"`（阿里云文档原文如此，末尾那个 & 不是笔误）。
 * 少了这个 & 就会一直返回 SignatureDoesNotMatch，而服务端回显的待签名串看起来又完全正确——很难查。
 */
export function buildStringToSign(params: Record<string, string>, method = 'POST'): string {
  return `${method}&${percentEncode('/')}&${percentEncode(canonicalize(params))}`;
}

export function signRequest(params: Record<string, string>, accessKeySecret: string, method = 'POST'): string {
  return createHmac('sha1', `${accessKeySecret}&`).update(buildStringToSign(params, method), 'utf8').digest('base64');
}

/** 阿里云的 Timestamp 要求 ISO8601 UTC、不带毫秒 */
export function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface BuildParamsInput {
  accessKeyId: string;
  phone: string;
  code: string;
  signName: string;
  templateCode: string;
  regionId: string;
  templateParamName: string;
  nonce: string;
  timestamp: string;
}

/** 拼出除 Signature 以外的全部请求参数（不含密钥，便于单测断言） */
export function buildSendSmsParams(input: BuildParamsInput): Record<string, string> {
  return {
    AccessKeyId: input.accessKeyId,
    Action: API_ACTION,
    Format: 'JSON',
    PhoneNumbers: input.phone,
    RegionId: input.regionId,
    SignName: input.signName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: input.nonce,
    SignatureVersion: '1.0',
    TemplateCode: input.templateCode,
    TemplateParam: JSON.stringify({ [input.templateParamName]: input.code }),
    Timestamp: input.timestamp,
    Version: API_VERSION,
  };
}

/** 把阿里云返回的错误码翻译成能照着排查的中文；未知错误码保留原始 Code 和 Message */
export function explainErrorCode(code: string, message?: string): string {
  const table: Record<string, string> = {
    'isv.BUSINESS_LIMIT_CONTROL': '同一号码发送过于频繁，被运营商限流（每分钟 1 条 / 每小时 5 条 / 每天 10 条），请稍后再试',
    'isv.DAY_LIMIT_CONTROL': '该号码今日发送条数已达上限',
    'isv.MONTHLY_LIMIT_CONTROL': '该号码本月发送条数已达上限',
    'isv.MOBILE_NUMBER_ILLEGAL': '手机号被阿里云判定为非法号码',
    'isv.SMS_SIGNATURE_ILLEGAL': '短信签名不可用：未审核通过，或与控制台里的签名名称不一致',
    'isv.SMS_TEMPLATE_ILLEGAL': '短信模板不可用：未审核通过，或模板 CODE 填错',
    'isv.SMS_CONTENT_ILLEGAL': '短信内容含敏感词，被拦截',
    'isv.AMOUNT_NOT_ENOUGH': '阿里云账户余额不足',
    'isv.OUT_OF_SERVICE': '短信服务已停用（可能欠费）',
    'isv.PARAM_LENGTH_LIMIT': '参数超长（验证码模板常见于模板变量名填错）',
    'SignatureDoesNotMatch': '签名校验失败：检查 ALIYUN_SMS_ACCESS_KEY_SECRET 是否填错或前后有空格',
    'InvalidAccessKeyId.NotFound': 'AccessKey ID 不存在，检查 ALIYUN_SMS_ACCESS_KEY_ID',
    'InvalidAccessKeyId': 'AccessKey ID 无效',
    'Forbidden.RAM': 'RAM 权限不足，需要给这个 AccessKey 授予 dysms:SendSms 权限',
    'Throttling.User': '请求被阿里云限流，稍后再试',
    'Throttling.Api': '接口被阿里云限流，稍后再试',
  };
  const known = table[code];
  if (known) return `${known}（${code}）`;
  return `阿里云返回 ${code}${message ? `：${message}` : ''}`;
}

/** 短信服务商返回业务失败 */
export class AliyunSmsError extends Error {
  constructor(
    readonly providerCode: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'AliyunSmsError';
  }
}

export interface AliyunSmsResponse {
  Code?: string;
  Message?: string;
  RequestId?: string;
  BizId?: string;
  [key: string]: unknown;
}

/** 签名并 POST 到阿里云（参数放 form body，密钥不出现在 URL 里）；业务失败抛 AliyunSmsError */
export async function callApi(
  config: AliyunSmsConfig,
  params: Record<string, string>,
  options: {
    fetchImpl?: typeof fetch;
    /** 失败提示里用的脱敏号码 */
    subject?: string;
  } = {},
): Promise<AliyunSmsResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // 签名只对除 Signature 以外的参数计算，算完再放进参数里一起发送
  const signature = signRequest(params, config.accessKeySecret);
  const body = `${canonicalize(params)}&${percentEncode('Signature')}=${percentEncode(signature)}`;

  let response: Response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    const reason = err?.name === 'TimeoutError' ? `请求超时（${REQUEST_TIMEOUT_MS} ms）` : String(err?.message || err);
    throw new AliyunSmsError('NETWORK_ERROR', `阿里云短信请求失败${options.subject ? `（${options.subject}）` : ''}：${reason}`);
  }

  const text = await response.text().catch(() => '');
  let payload: AliyunSmsResponse | null = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok || !payload || payload.Code !== 'OK') {
    const providerCode = payload?.Code || `HTTP_${response.status}`;
    const detail = explainErrorCode(providerCode, payload?.Message ?? (text ? text.slice(0, 200) : undefined));
    throw new AliyunSmsError(providerCode, `短信息请求失败${options.subject ? `（${options.subject}）` : ''}：${detail}`, payload?.RequestId);
  }
  return payload;
}

export class AliyunSmsSender implements SmsSender {
  readonly name = 'aliyun';

  constructor(
    private readonly config: AliyunSmsConfig,
    /** 测试时注入假 fetch */
    private readonly fetchImpl: typeof fetch = fetch,
    /** 测试时固定 nonce / 时间戳 */
    private readonly clock: () => Date = () => new Date(),
    private readonly nonce: () => string = () => randomUUID(),
  ) {}

  async sendLoginCode(phone: string, code: string): Promise<void> {
    const params = buildSendSmsParams({
      accessKeyId: this.config.accessKeyId,
      phone,
      code,
      signName: this.config.signName,
      templateCode: this.config.templateCode,
      regionId: this.config.regionId,
      templateParamName: this.config.templateParamName,
      nonce: this.nonce(),
      timestamp: formatTimestamp(this.clock()),
    });
    const payload = await callApi(this.config, params, {
      fetchImpl: this.fetchImpl,
      subject: maskPhone(phone),
    });
    // 注意：到这里只代表「阿里云受理成功」，是否真的送到手机要看回执（见 querySendDetails）
    console.log(`[SMS][aliyun] 验证码已提交 → ${maskPhone(phone)}（签名「${this.config.signName}」，模板 ${this.config.templateCode}，RequestId ${payload.RequestId || '-'}）`);
  }
}

// ─── 回执查询（QuerySendDetails）────────────────────────────────────────────

export type SmsSendStatus = 'pending' | 'success' | 'failed' | 'unknown';

export interface SmsSendDetail {
  phone: string;
  /** 模板内容（含验证码原文，仅联调用） */
  content: string;
  templateCode: string;
  /** 提交时间 / 运营商回执时间，本地时区可读字符串 */
  sendDate: string;
  receiveDate?: string;
  status: SmsSendStatus;
  /** 状态的中文说明 */
  statusText: string;
  /** 运营商回执错误码，成功时为空 */
  errCode?: string;
  /** 错误码的中文解释 */
  errText?: string;
}

export function buildQuerySendDetailsParams(input: {
  accessKeyId: string;
  phone: string;
  /** yyyyMMdd（阿里云按北京时间分日） */
  sendDate: string;
  regionId: string;
  nonce: string;
  timestamp: string;
  pageSize?: number;
  currentPage?: number;
}): Record<string, string> {
  return {
    AccessKeyId: input.accessKeyId,
    Action: 'QuerySendDetails',
    CurrentPage: String(input.currentPage ?? 1),
    Format: 'JSON',
    PageSize: String(input.pageSize ?? 10),
    PhoneNumber: input.phone,
    RegionId: input.regionId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: input.nonce,
    SignatureVersion: '1.0',
    SendDate: input.sendDate,
    Timestamp: input.timestamp,
    Version: API_VERSION,
  };
}

/** 运营商 / 阿里云的投递回执错误码，翻译成能照着排查的中文 */
export function explainReceiptError(errCode: string): string {
  const table: Record<string, string> = {
    PORT_NOT_REGISTERED:
      '运营商侧没有该号码的登记端口：常见于签名 / 短信通道仍在审核或只开通了部分能力，也可能是号码本身无效（空号、停机、虚拟号段）。带 RequestId 提工单问阿里云最快',
    MOBILE_NOT_EXIST: '号码不存在（空号）',
    BLACK_LIST: '号码在运营商黑名单里',
    SIGNATURE_UNDER_REVIEW: '签名仍在审核中，运营商暂不放行',
    TEMPLATE_UNDER_REVIEW: '模板仍在审核中，运营商暂不放行',
  };
  return table[errCode] || `运营商回执错误码 ${errCode}`;
}

function toStatusText(status: SmsSendStatus): string {
  return { pending: '等待回执', success: '发送成功', failed: '发送失败', unknown: '未知状态' }[status];
}

/** 解析 QuerySendDetails 的返回（原始 JSON 是大写键，SDK 会转成小写，这里两种都认） */
export function parseSendDetails(payload: AliyunSmsResponse): SmsSendDetail[] {
  const raw: any = (payload as any).SmsSendDetailDTOs ?? (payload as any).smsSendDetailDTOs ?? {};
  const list = raw.SmsSendDetailDTO ?? raw.smsSendDetailDTO ?? [];
  const items = Array.isArray(list) ? list : [list];
  return items
    .filter(Boolean)
    .map((item: any) => {
      const numeric = Number(item.SendStatus ?? item.sendStatus);
      const status: SmsSendStatus = numeric === 3 ? 'success' : numeric === 2 ? 'failed' : numeric === 1 ? 'pending' : 'unknown';
      const errCode: string | undefined = item.ErrCode ?? item.errCode ?? undefined;
      return {
        phone: item.PhoneNum ?? item.phoneNum ?? '',
        content: item.Content ?? item.content ?? '',
        templateCode: item.TemplateCode ?? item.templateCode ?? '',
        sendDate: item.SendDate ?? item.sendDate ?? '',
        receiveDate: item.ReceiveDate ?? item.receiveDate ?? undefined,
        status,
        statusText: toStatusText(status),
        errCode,
        errText: errCode ? explainReceiptError(errCode) : undefined,
      };
    });
}

/** 查询某个号码某天的发送记录（含投递回执），用来自查「到底送到手机没有」 */
export async function querySendDetails(
  config: AliyunSmsConfig,
  input: { phone: string; sendDate: string; pageSize?: number; currentPage?: number },
  options: { fetchImpl?: typeof fetch; clock?: () => Date; nonce?: () => string } = {},
): Promise<SmsSendDetail[]> {
  const params = buildQuerySendDetailsParams({
    accessKeyId: config.accessKeyId,
    phone: input.phone,
    sendDate: input.sendDate,
    regionId: config.regionId,
    pageSize: input.pageSize,
    currentPage: input.currentPage,
    nonce: (options.nonce ?? (() => randomUUID()))(),
    timestamp: formatTimestamp((options.clock ?? (() => new Date()))()),
  });
  const payload = await callApi(config, params, {
    fetchImpl: options.fetchImpl,
    subject: maskPhone(input.phone),
  });
  return parseSendDetails(payload);
}
