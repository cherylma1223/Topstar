/**
 * 短信通道自查（本地联调用）
 *
 * 用法：
 *   cd server && npm run verify-sms -- 13800138000            # 按当前配置发（开发默认演练，不调阿里云）
 *   cd server && npm run verify-sms -- 13800138000 --real     # 强制真发一条（浪费 0.045 元，慎重）
 *   cd server && npm run verify-sms -- 13800138000 --status   # 查这个号码今天的发送记录与投递回执
 *
 * 为什么要分两个动作：调 SendSms 返回 OK 只代表「阿里云受理了」，短信有没有真的到手机，
 * 要看运营商的投递回执（QuerySendDetails）。签名 / 通道还在审核、号码空号、被运营商拦截，
 * 都表现为受理成功但回执失败（常见 PORT_NOT_REGISTERED）。
 *
 * 注意：真发是花钱的（国内验证码短信约 0.045 元/条），且运营商有「同号 1 条/分钟、5 条/小时、10 条/天」的限制。
 */
import 'dotenv/config';
import { randomInt } from 'node:crypto';
import { createSmsSender } from '../auth/sms';
import { normalizePhone, maskPhone } from '../auth/phone';
import { AliyunSmsError, querySendDetails, readAliyunSmsConfig } from '../auth/aliyunSms';

/** 北京时间 yyyyMMdd（阿里云按北京时间分日） */
function todayInChina(): string {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
}

async function printStatus(phone: string) {
  const config = readAliyunSmsConfig();
  const date = todayInChina();
  console.log(`查询 ${maskPhone(phone)} 在 ${date} 的发送记录…`);
  const records = await querySendDetails(config, { phone, sendDate: date, pageSize: 10 });
  if (!records.length) {
    console.log('没有记录（号码 / 日期不对，或者今天还没发过）');
    return;
  }
  console.log('');
  records.forEach((r, i) => {
    const icon = r.status === 'success' ? '✓' : r.status === 'failed' ? '✗' : '…';
    console.log(`${icon} [${i + 1}] ${r.statusText}　提交 ${r.sendDate}${r.receiveDate ? `　回执 ${r.receiveDate}` : ''}`);
    console.log(`     内容：${r.content}`);
    if (r.errCode) console.log(`     回执码：${r.errCode} —— ${r.errText}`);
  });
  const failed = records.filter((r) => r.status === 'failed');
  console.log('');
  if (failed.length) {
    console.log(`结论：${failed.length}/${records.length} 条投递失败。这不是代码问题——阿里云已受理、运营商拒投，`);
    console.log('      拿上面的回执码和 RequestId 找阿里云工单，或在控制台「短信服务 → 国内消息 → 发送记录」看详情。');
  } else if (records.some((r) => r.status === 'success')) {
    console.log('结论：有记录显示发送成功（sendStatus=3），手机应该收到了。');
  } else {
    console.log('结论：还在等待回执（sendStatus=1），过一两分钟再查一次。');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const wantStatus = args.includes('--status');
  if (args.includes('--real')) process.env.SMS_DRY_RUN = '0';
  const rawPhone = args.find((a) => !a.startsWith('--'));
  const phone = normalizePhone(rawPhone || '');
  if (!phone) {
    console.error('用法：npm run verify-sms -- <11 位手机号> [--real] [--status]');
    process.exit(1);
  }

  if (wantStatus) {
    await printStatus(phone);
    return;
  }

  const provider = (process.env.SMS_PROVIDER || (process.env.NODE_ENV === 'production' ? '' : 'console')).trim();
  const sender = createSmsSender();

  console.log('── 短信通道自检 ─────────────────────────────');
  console.log(`通道        ${sender.name}`);
  if (sender.name === 'aliyun') {
    console.log(`签名        ${process.env.ALIYUN_SMS_SIGN_NAME}`);
    console.log(`模板 CODE   ${process.env.ALIYUN_SMS_TEMPLATE_CODE}`);
    console.log(`模板变量    ${process.env.ALIYUN_SMS_TEMPLATE_PARAM || 'code'}`);
    const secret = process.env.ALIYUN_SMS_ACCESS_KEY_SECRET || '';
    console.log(`AccessKey   ${process.env.ALIYUN_SMS_ACCESS_KEY_ID}（Secret ${secret ? secret.slice(0, 4) + '***' : '缺失'}）`);
  } else {
    console.log(`提示        当前通道是 console，不会真发短信；要看真实效果请配置 SMS_PROVIDER=aliyun`);
  }
  console.log(`配置开关    SMS_DRY_RUN=${process.env.SMS_DRY_RUN ?? '（未设置，开发默认演练）'}`);
  console.log(`目标号码    ${maskPhone(phone)}`);
  console.log('────────────────────────────────────────────');

  const code = String(randomInt(100000, 1000000));
  const startedAt = Date.now();
  try {
    await sender.sendLoginCode(phone, code);
    console.log(`✓ 阿里云已受理（耗时 ${Date.now() - startedAt} ms），验证码 ${code}`);
    if (provider === 'console') {
      console.log('  （console 通道只是把验证码打印在日志里，不产生真实短信）');
      return;
    }
    if (sender.name !== 'aliyun') {
      console.log('  （演练模式：短信没有真的发出去。要真发：npm run verify-sms -- ' + phone + ' --real）');
      return;
    }
    console.log('  ⚠ 受理成功 ≠ 送达。查投递回执：');
    console.log(`     npm run verify-sms -- ${phone} --status`);
    console.log('  没收到短信时按这个顺序查：');
    console.log('   1. 先看回执，回执失败就是阿里云/运营商侧的问题（签名或通道未审批通过、号码无效、被拦截）');
    console.log('   2. 手机是否拦截了未知号码 / 短信是否被折叠到通知栏');
    console.log('   3. 控制台 → 短信服务 → 国内消息 → 发送记录，按手机号搜');
  } catch (err: any) {
    const isProviderError = err instanceof AliyunSmsError;
    console.error(`✗ 发送失败：${err?.message || err}`);
    if (isProviderError) {
      console.error(`  错误码 ${err.providerCode}，RequestId ${err.requestId || '-'}`);
      console.error('  拿 RequestId 找阿里云工单排查最快；错误码对照见 server/auth/aliyunSms.ts 的 explainErrorCode');
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
