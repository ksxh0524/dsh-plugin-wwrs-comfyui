/** errors.ts —— fail-loud 错误载荷（输入校验唯一出口）。
 *
 * 所有输入校验错误抛 FailLoudError，四字段齐全 {error, param, expected, example}——
 * 调用方照 example 改 param 即过，不用来回试。执行期失败（远端非 2xx/超时/取消）
 * 抛普通 Error（ComfyUIError 见 lib/comfy-client.ts），消息带上下文；载荷永不含
 * 凭据（token 只活在请求头里，不进 message/raw 日志面）。
 */

export type FailLoudFields = {
  /** 发生了什么（含收到值与上下文，一行讲清）。 */
  error: string;
  /** 出问题的参数名。 */
  param: string;
  /** 期望的形状/约束。 */
  expected: string;
  /** 能直接照抄的改对例子。 */
  example: string;
};

export class FailLoudError extends Error {
  readonly param: string;
  readonly expected: string;
  readonly example: string;
  private readonly brief: string;

  constructor(fields: FailLoudFields) {
    super(`${fields.error}（param=${fields.param}；expected=${fields.expected}；example=${fields.example}）`);
    this.name = "FailLoudError";
    this.brief = fields.error;
    this.param = fields.param;
    this.expected = fields.expected;
    this.example = fields.example;
  }

  toFields(): FailLoudFields {
    return { error: this.brief, param: this.param, expected: this.expected, example: this.example };
  }
}

/** 错误收据化：工具 execute 的统一出口（message 截断防日志爆炸）。 */
export function errorFields(e: unknown): FailLoudFields {
  if (e instanceof FailLoudError) return e.toFields();
  const msg = e instanceof Error ? e.message || String(e) : String(e);
  return { error: msg.slice(0, 2000), param: "", expected: "", example: "" };
}
