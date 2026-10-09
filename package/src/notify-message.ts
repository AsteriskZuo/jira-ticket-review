/**
 * 企微通知消息组装（v2 ReviewNotificationObserver 的拼装逻辑）。
 * 只负责 content/mentions 的形状，投递由平台出口（wecom-webhook）包办。
 */

import {
  lookupWeComAccount as defaultLookupWeComAccount,
  type WeComAccount,
} from "./person-mapping.js";
import type { ReviewOutput } from "./review-output.js";

/** 工单相关人的原始身份（jira-fetch 的 identity 旁路，未脱敏） */
export type ReviewIdentity = {
  reporterEmail?: string;
  reporterName?: string;
  assigneeEmail?: string;
  assigneeName?: string;
};

/** wecom-webhook 出口 resultDoc 形状：content 为 markdown 正文，mentions 拼 <@userid> */
export type NotifyMessage = {
  content: string;
  /** 仅映射表命中或拼音猜中时携带 */
  mentions?: string[];
};

type LookupFn = (user: {
  emailAddress?: string;
  name?: string;
}) => Promise<WeComAccount | undefined>;

/**
 * 组装 pass/fail 审查结果的企微消息。
 * @ 人规则：pass @ 负责人（assignee），fail @ 创建者（reporter）。
 * 映射表查不到 → 拼音全拼兜底（guessed，消息带提示行）；仍无 → 消息带
 * 「未找到企微账号」提示行，mentions 为空。
 * 工单链接从 config 的 jira_url 派生（/browse/{key}）。
 */
export async function buildNotifyMessage(
  args: {
    review: ReviewOutput;
    identity?: ReviewIdentity;
    jiraUrl: string;
  },
  lookupWeComAccount: LookupFn = defaultLookupWeComAccount,
): Promise<NotifyMessage> {
  const { review, identity, jiraUrl } = args;

  const isPass = review.decision === "pass";
  const targetLabel = isPass ? "负责人" : "创建者";
  const targetEmail = isPass
    ? identity?.assigneeEmail
    : identity?.reporterEmail;
  const targetName = isPass ? identity?.assigneeName : identity?.reporterName;
  const wecomAccount = await lookupWeComAccount({
    emailAddress: targetEmail,
    name: targetName,
  });

  const ticketUrl = `${jiraUrl.replace(/\/+$/, "")}/browse/${review.issueKey}`;
  const emoji = isPass ? "✅" : "❌";
  const title = `**工单审查${isPass ? "通过" : "不通过"} ${emoji}**`;

  const lines: string[] = [
    title,
    "",
    `> 工单：[${review.issueKey}](${ticketUrl})`,
  ];

  if (isPass && review.classification) {
    lines.push(`> 分类：${review.classification}`);
  }

  if (!isPass && review.reason) {
    lines.push(`> 原因：${review.reason}`);
  }

  lines.push(
    `> 审查时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
  );

  let mentions: string[] | undefined;
  if (wecomAccount) {
    mentions = [wecomAccount.wecomUserid];
    lines.push("");
    if (wecomAccount.guessed) {
      lines.push(
        `ℹ️ 未在映射表中找到${targetLabel}（${targetEmail ?? targetName}）的企微账号，已按拼音猜测 @${wecomAccount.wecomUserid}，若 @ 错或未 @ 到请补充映射表。`,
      );
      lines.push("");
    }
    lines.push(review.summary);
  } else {
    lines.push("");
    if (targetEmail || targetName) {
      lines.push(
        `⚠️ 未找到${targetLabel}（${targetEmail ?? targetName}）的企微账号，无法 @ 通知。`,
      );
    }
    lines.push(review.summary);
  }

  return {
    content: lines.join("\n"),
    ...(mentions ? { mentions } : {}),
  };
}
