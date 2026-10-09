import { sdk } from "@asterisk/agent-sdk";
import { JiraClient } from "../jira-client.js";
import { createIssueMasker } from "../masking.js";

// jira-fetch 工具入口：jira 表单登录 + 拉取工单 + 脱敏（spec §6）。
// 契约（与流程程序同构的一入一出）：
//   input  = { issue_key }；config = { jira_url, username, password }
//   （工具拿不到 secrets，凭据由调用方显式放进 config）
// 成功 sdk.return({ status:'success', data:<脱敏工单>, identity })；
// jira 层失败也走 sdk.return({ status:'error', code, message })——error 双态
// 是业务可判别的正常输出；sdk.fail 只留给信封/参数非法。
const { input, config } = sdk.runInput();

const issueKey = (input as { issue_key?: unknown } | null)?.issue_key;
if (typeof issueKey !== "string" || issueKey.length === 0) {
  sdk.fail("input 非法：缺 issue_key（非空字符串）");
}

const missingKeys = ["jira_url", "username", "password"].filter(
  (key) => typeof config[key] !== "string" || config[key].length === 0,
);
if (missingKeys.length > 0) {
  sdk.fail(`config 非法：缺 ${missingKeys.join("、")}`);
}

const client = new JiraClient({
  jiraUrl: config.jira_url,
  username: config.username,
  password: config.password,
  sanitizeIssueData: createIssueMasker(),
});

// includeComments：全部评论都是审查证据（SKILL.md 判定原则）
const result = await client.getIssue(issueKey, { includeComments: true });
sdk.return(result);
