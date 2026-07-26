import { ContextStore } from "@info/core";

const store = new ContextStore();
const pack = store.buildPack({
  goal: "设计 personal context system 的 context layer",
  scope: { project: "personal-context-system" },
  token_budget: 3000,
});
console.log(pack.markdown);
