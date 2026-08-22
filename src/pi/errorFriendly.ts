/**
 * 错误信息友好化：把上游模型的原始错误 JSON 转成可读的中文提示。
 */
export function friendlyError(raw: string): string {
  if (!raw) return raw || "未知错误";
  const s = String(raw);

  // 413 Payload Too Large
  if (s.includes("413") || /payload\s*too\s*large/i.test(s)) {
    return (
      "请求体过大（413）：本次发给模型的全部历史（含多次工具输出）超出上游服务限制。\n" +
      "建议：点「压缩上下文」将大型工具输出摘要化，再重新发送。"
    );
  }
  // 529 overloaded
  if (/(529|overloaded)/i.test(s)) {
    return "上游服务过载（529），已自动重试；持续失败请稍后再试。";
  }
  // 429 rate limit（含重试时间）
  if (/(429|rate\s*limit|too\s*many\s*requests)/i.test(s)) {
    return "请求频率受限（429）：请稍等片刻再发送（通常几十秒后自动恢复）。";
  }
  // 认证
  if (/(401|unauthorized|invalid\s*api\s*key|authentication)/i.test(s)) {
    return "认证失败（401）：请检查该模型的 API Key 是否有效（设置 → 模型提供商）。";
  }
  // 配额/额度
  if (/(402|quota|insufficient|billing)/i.test(s)) {
    return "额度或配额不足（402）：请检查账户余额或用量。";
  }
  // 模型不存在
  if (/(model\s*not\s*found|404)/i.test(s)) {
    return "模型不存在或不可用：请重新选择模型。";
  }
  // 上下文超长（400 context length）
  if (/(context\s*length|context\s*window|maximum\s*context|too\s*long|input.*exceed)/i.test(s)) {
    return "上下文超出窗口限制：请点「压缩上下文」精简历史后重发，或新建会话。";
  }
  // 服务端错误
  if (/(5\d\d|internal\s*server|bad\s*gateway|service\s*unavailable)/i.test(s)) {
    return "模型服务端错误（5xx）：已自动重试；持续失败请稍后再试或换模型。";
  }
  // 超时
  if (/(timeout|timed\s*out|deadline\s*exceeded)/i.test(s)) {
    return "请求超时：网络或模型响应过慢，可重试或检查网络。";
  }
  // 网络错误
  if (/(fetch\s*failed|network\s*error|ENOTFOUND|ECONNREFUSED|ECONNRESET|EPIPE)/i.test(s)) {
    return "网络错误（无法连接模型服务）：请检查网络后重试。";
  }
  // 内容审核
  if (/(moderation|content\s*policy|policy\s*violation|harmful)/i.test(s)) {
    return "内容被审核拦截：请调整措辞后重试（避免敏感/危险内容）。";
  }

  // 尝试剥离 JSON 包装，只留 message 字段
  try {
    const parsed = JSON.parse(s);
    if (parsed?.message) return `模型返回错误：${String(parsed.message)}`;
  } catch {
    /* 非 JSON，原样返回 */
  }
  return s;
}

/** 判断是否值得自动重试（临时性错误：限流/过载/5xx/超时/网络） */
export function isRetryableError(raw: string): boolean {
  if (!raw) return false;
  const s = String(raw);
  return /(529|overloaded|429|rate\s*limit|too\s*many\s*requests|5\d\d|internal\s*server|bad\s*gateway|service\s*unavailable|timeout|timed\s*out|fetch\s*failed|network\s*error|ENOTFOUND|ECONNREFUSED|ECONNRESET|EPIPE|deadline\s*exceeded)/i.test(
    s,
  );
}