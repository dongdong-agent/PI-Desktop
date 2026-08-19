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
  // 529 overloaded / rate limit
  if (/(529|overloaded|rate\s*limit|too\s*many\s*requests)/i.test(s)) {
    return "上游服务过载或限流（529/429），稍后自动重试或过一会儿再试。";
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

  // 尝试剥离 JSON 包装，只留 message 字段
  try {
    const parsed = JSON.parse(s);
    if (parsed?.message) return `模型返回错误：${String(parsed.message)}`;
  } catch {
    /* 非 JSON，原样返回 */
  }
  return s;
}