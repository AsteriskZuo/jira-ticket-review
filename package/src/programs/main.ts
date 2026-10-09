import { sdk } from "@asteriskzuo/agent-sdk";
import { runReviewFlow } from "../review-flow.js";

// 入口程序（薄）：读信封 → review-flow 编排 → 唯一出口。
// 契约四条：stdin 一段 JSON 进、stdout 一段 JSON 出（sdk.return/sdk.fail）、
// 失败语义机械（任何一步失败 = 整体失败）、日志走 sdk.log（stderr，平台采集）。
const { event } = sdk.input();

const outcome = await runReviewFlow(event, {
  run: sdk.run,
  agent: sdk.agent,
  config: sdk.config,
  secret: sdk.secret,
  log: sdk.log,
});

if (outcome.type === "fail") {
  sdk.fail(outcome.reason);
}
sdk.return(outcome.value);
