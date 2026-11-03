import { sdk } from "@asteriskzuo/agent-sdk";
import { runReviewFlow } from "../../packages/review-flow.js";

// 入口程序（薄壳，apps/ 布局：实现代码归 packages/）：读信封 → review-flow 编排 → 唯一出口。
// 契约四条：stdin 一段 JSON 进、stdout 一段 JSON 出（sdk.return/sdk.fail）、
// 失败语义机械（任何一步失败 = 整体失败）、日志走 sdk.log（stderr，平台采集）。
// 入口检查在 check-input 程序（平台编排第一阶段）；本程序仍从原始信封自行解析（纯校验不转换纪律）。
const { event } = sdk.input();

const outcome = await runReviewFlow(event, {
  run: sdk.run,
  agent: sdk.agent,
  models: sdk.models,
  config: sdk.config,
  secret: sdk.secret,
  log: sdk.log,
});

if (outcome.type === "fail") {
  sdk.fail(outcome.reason);
}
sdk.return(outcome.value);
