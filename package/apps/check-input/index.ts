import { checkFields, loadContract, sdk } from "@asteriskzuo/agent-sdk";

// 入口检查程序（平台三段编排第一阶段，保留程序名 check-input）：
// 解释 contract.json 的 input 契约——required 项查存在 + 类型（payload.issue_key），可选项不查。
// 纯校验纪律：只判过/不过、不做转换（解析归 main）；平台对本阶段最小注入（无 secrets/endpoint/programs/dataDir）。
const { event } = sdk.input();
const contract = loadContract(
  new URL("../../../contract.json", import.meta.url),
);
if (contract.input !== null) {
  const problems = checkFields(contract.input.fields, event);
  if (problems.length > 0) sdk.fail(problems.join("；"));
}
sdk.return({});
