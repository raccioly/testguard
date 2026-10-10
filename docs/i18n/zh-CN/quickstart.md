> 🌐 这是译文，以英文页面为准：[docs/quickstart.md](https://github.com/raccioly/testguard/blob/main/docs/quickstart.md)。翻译自 v0.18.3。

# 快速入门

本页带你从零开始，在大约十分钟内得到第一个被 TestGuard 接纳（admit）的测试。它面向第一次尝试 TestGuard 的读者，前提是你有一个 JavaScript 或 TypeScript 项目，并且其 vitest 或 jest 测试套件全部通过（全绿）。你会先看到它在本仓库自带的演示项目中找出一个真实的盲区；然后在你自己的一个小项目上运行同一个循环。下面的每一段输出都取自真实运行；较长的路径用 `…` 缩写。

你需要 Node ≥ 20 和 `git`。其他安装方式及其各自的要求，见[安装](../../installation.md)。

## 1. 观察它如何工作：已知答案夹具

仓库自带一个很小的项目 `fixtures/known-answer/`，即已知答案夹具（fixture），专门用来产生 TestGuard 能给出的每一种判定结果（verdict）。它的审计日志测试用 `expect.objectContaining({...})` 检查该行，但从未提及 `content` 字段，因此把**原始密钥**写入审计行后，测试套件仍然是绿色。

```bash
git clone https://github.com/raccioly/testguard.git
cd testguard
npm install                                      # the fixture borrows the repository's vitest
node cli/testguard.mjs claims fixtures/known-answer   # what the fixture claims
node cli/testguard.mjs probe fixtures/known-answer    # try to falsify every claim
```

在 TestGuard 仓库内部，你通过 `node cli/testguard.mjs` 从源码运行 CLI，因为一个包永远不会被安装进它自己的 `node_modules`。在你自己的项目中，则使用 `npx testguard-cli`。

在这个夹具上，探测（probe）只需几秒钟，退出码为 `1`：

```text
SURVIVED        REDACT-001/F1          critical src/redact.mjs  Audit row carries the raw input instead of the redacted text.
SURVIVED        REDACT-001/F3          critical src/redact.mjs  The content field is dropped from the audit row entirely (the field-dropped shape). Same blind spot as F1: objectContaining never lists `content`.
SURVIVED        REDACT-003/F1          high     src/redact.mjs  Fail-closed guard removed; a missing scope proceeds unscoped.
TIMEOUT         REDACT-004/F1          medium   src/redact.mjs  redact() returns a promise that never settles.  [test-timed-out]
UNVERIFIABLE    REDACT-005/F1          low      src/redact.mjs  Anchor that no longer exists in the source (rotted).  [anchor-missing]
UNVERIFIABLE    REDACT-005/F2          low      src/redact.mjs  Anchor that matches more than once (ambiguous): `return null;` occurs in two functions.  [anchor-ambiguous: 2 hits, expected 1]
FAULT-INVALID   REDACT-006/F1          low      src/redact.mjs  Replacement that does not parse (a bad fault, not a detection).  [replacement-does-not-compile]
NOCOVER         EXPORT-001/F1          medium   src/export.mjs  Export keeps the content field.
FLAKY-DEFENDER  FLAKY-001/F1           low      src/redact.mjs  Any fault at all; the defender's flakiness pre-empts the verdict.  [defenders-not-green]
NOCOVER         EXPORT-002/F1          medium   src/export.mjs  Export keeps the content field. No defendedBy: the only test that imports src/export mocks it and never asserts on it, so discovery must find NO defender — a mock cannot detect a fault in what it replaces.  (defenders discovered by import)

  4 killed (not listed; --verbose to see them)
14 faults probed: 3 SURVIVED, 2 NOCOVER, 2 UNVERIFIABLE, 1 FAULT-INVALID, 1 TIMEOUT, 1 FLAKY-DEFENDER, 4 killed. 10 unproven faults across 8 claims. Probed 379fb6a.
…
evidence: …/fixtures/known-answer/.testguard/evidence.json
```

看第一行。TestGuard 在 `src/redact.mjs` 中把脱敏后的文本换成了原始输入，将审计行测试运行了三次，每次都通过了。这就是 `SURVIVED`：存活下来的是**故障（fault）**，这是坏消息。健康的报告里大多是 `killed`。

其他判定结果是有意安排的；该夹具的 [README](../../../fixtures/known-answer/README.md) 解释了每一种，[判定结果](../../reference/verdicts.md)则说明了每一种该如何处理。

## 2. 你自己的项目

本页余下的部分在一个小型计费模块上运行这个循环。如果你自己的项目有全绿的 vitest 或 jest 测试套件，也可以直接使用它；命令完全相同。

起点是一个源文件和一个测试：

```js
// src/billing.mjs
export function orderTotal(order) {
  if (!order.items.length) {
    throw new Error('an order needs at least one item');
  }
  const subtotal = order.items.reduce((sum, item) => sum + item.price * item.qty, 0);
  if (order.coupon === 'HALF' && subtotal >= 100) {
    return { subtotal, total: subtotal / 2 };
  }
  return { subtotal, total: subtotal };
}
```

```js
// test/billing.test.mjs
import { it, expect } from 'vitest';
import { orderTotal } from '../src/billing.mjs';

it('halves an order of 100 or more with the HALF coupon', () => {
  expect(orderTotal({ items: [{ price: 60, qty: 2 }], coupon: 'HALF' }).total).toBe(60);
});
```

### 安装与 `init`

```bash
npm i -D testguard-cli          # pins the version in your lockfile
npx testguard-cli init          # the agent layer and the .gitignore lines
```

```text
+ .claude/skills/testguard/SKILL.md
+ .claude/settings.json: SessionStart hook → brief --text (local install first, then a testguard on PATH, never a fetch)
+ AGENTS.md created with the TestGuard section
+ .gitignore: 12 lines added

Agents now start with the blind-spot brief and can run `testguard status --json` to learn what to do next. The hook prefers a local install and never fetches from the network.
Commit these files.
```

`init` 会写入 AI 智能体（agent）在会话启动时读取的文件：一个技能（skill）、一个打印盲区简报（brief）的钩子（hook），以及一段 `AGENTS.md` 章节。它还会忽略每次运行都会重新生成的 `.testguard/` 文件。如果你不使用智能体，这些文件也无害；[AI 智能体](../../guides/ai-agents.md)对它们有说明。请 commit 它们。

### 查看你所处的阶段

```bash
npx testguard-cli status        # the state and the ONE next action
```

```text
state: no-claims — 0 claims / 0 faults
surface:  0 of 1 source modules carry a claim; 0 of 1 highest-churn modules claimed (last 3 commits)
UNCLAIMED src/billing.mjs — 1 change in history window; path risk: money
next:     [scaffold] testguard scaffold src/billing.mjs
why:      1 source module exist and none carries a claim. Start with src/billing.mjs, …
```

`status` 以 `2` 退出：目前还没有可以探测的东西。`init` 不会创建声明（claim）文件，在该文件存在之前，`claims` 和 `probe` 都会以
`error: cannot read claims file testguard.claims.json` 停止。先从一个空文件开始：

```json
{
  "$schema": "./node_modules/testguard-cli/spec/schemas/claims.schema.json",
  "schemaVersion": 1,
  "claims": []
}
```

```bash
npx testguard-cli claims        # 0 claims in testguard.claims.json — exit 0
npx testguard-cli probe         # "claims file declares no claims; nothing to verify" — exit 2
```

`probe` 会以退出码 `2` 拒绝空的声明文件，因为一次什么都没有验证的运行，绝不能看起来像是通过了。在 CI 中逐步采用 TestGuard 期间，`probe --allow-empty` 会跳过合法的空文件、以 `0` 退出，并明确说明这一点。见
[GitHub Actions](../../guides/ci/github-actions.md#adopting-with-zero-claims)。

### 让 `scaffold` 提出故障

```bash
npx testguard-cli scaffold src/billing.mjs    # a draft, never your claims file
```

```text
2 proposed faults in 1 draft claim for src/billing.mjs — 2 condition-forced
defendedBy prefilled from imports: test/billing.test.mjs
draft: .testguard/scaffold-billing.json
Next: Supply intended observable behavior from a requirement, ADR, bug or incident independently of the implementation: …
```

草稿把机械生成的提议放在一个 `TODO-CLAIM-1` 占位符之下。每个故障（fault）都是一处精确的源码改动，它会破坏某个东西：

```json
{
  "id": "S1",
  "description": "[line 2] Guard never triggers: `if (!order.items.length)` becomes `if (false)`.",
  "faultClass": "condition-forced",
  "file": "src/billing.mjs",
  "find": "  if (!order.items.length) {",
  "replace": "  if (false) {",
  "producedBy": { "producer": "derived", "by": "testguard scaffold <version>" }
}
```

提议不等于声明。`scaffold` 读的是代码；它不知道代码**本应**做什么，而从代码出发写出的声明，只会复述代码今天的行为，连同其中的 bug 一起。

### 把一条提议变成声明

从实现以外的地方获取意图：一项需求、一个工单、一次事故。这里，计费需求规定空订单必须被拒绝。写下这句话，保留与之匹配的故障，并记录意图的来源：

```json
{
  "$schema": "./node_modules/testguard-cli/spec/schemas/claims.schema.json",
  "schemaVersion": 1,
  "claims": [
    {
      "id": "BILLING-EMPTY-ORDER",
      "statement": "An order with no items is refused; it never produces a total.",
      "source": { "kind": "spec", "ref": "billing requirements, rule 1" },
      "severity": "high",
      "producedBy": { "producer": "human", "by": "you" },
      "defendedBy": ["test/billing.test.mjs"],
      "faults": [
        {
          "id": "F1",
          "description": "Guard never triggers: an empty order is totalled instead of refused.",
          "faultClass": "condition-forced",
          "file": "src/billing.mjs",
          "find": "  if (!order.items.length) {",
          "replace": "  if (false) {",
          "producedBy": { "producer": "derived", "by": "testguard scaffold" }
        }
      ]
    }
  ]
}
```

在为它花费一次探测之前，先检查锚点（anchor）：

```bash
npx testguard-cli claims --check-anchors    # finds every anchor and parses every replacement; runs no tests
```

```text
  BILLING-EMPTY-ORDER high     spec        1 fault   1 defender    An order with no items is refused; it never produces a total.

OK               BILLING-EMPTY-ORDER/F1  src/billing.mjs — 1 hit, expected 1; javascript syntax ok
anchor preflight: 1 faults checked, 1 ok, 0 invalid in 27ms
```

`claims` 还会打印一条注解建议：该声明在源码中没有 `@claim` 注释。注释是可选的，不会改变任何判定结果；见
[编写声明](../../guides/writing-claims.md)。

### 探测它

```bash
npx testguard-cli probe         # apply each fault in a scratch worktree and run its defenders
```

```text
  … BILLING-EMPTY-ORDER/F1 baseline 1/3
  … BILLING-EMPTY-ORDER/F1 baseline 2/3
  … BILLING-EMPTY-ORDER/F1 baseline 3/3
  … BILLING-EMPTY-ORDER/F1 probe 1/3
  … BILLING-EMPTY-ORDER/F1 probe 2/3
  … BILLING-EMPTY-ORDER/F1 probe 3/3
  … BILLING-EMPTY-ORDER/F1 negative-control 1/1
SURVIVED        BILLING-EMPTY-ORDER/F1 high     src/billing.mjs  Guard never triggers: an empty order is totalled instead of refused.

1 faults probed: 1 SURVIVED. 1 unproven fault across 1 claim. Probed 13c8d1b.
… No baseline.
evidence: .testguard/evidence.json
```

探测以 `1` 退出。它先在未修改的代码上把守护测试（defender）运行三次（必须是绿色，否则无法得出任何结论），然后在禁用该守卫条件的情况下再运行三次。测试始终是绿色：测试套件中没有任何东西检查空订单是否被拒绝。你的工作区从未被改动；故障是在一个临时的 git worktree 中应用的。

### 解读 SURVIVED

`status` 和简报会把证据（evidence）转化为下一步行动：

```bash
npx testguard-cli brief --text  # the same block the session-start hook gives an agent
```

```text
## TEST BLINDSPOT CONTEXT

testguard <version> (local install) @ bee6ee9530c6 — 1 claims, 1 faults probed, 1 unproven (no baseline; everything is new).
…
NEXT [write-test]: write a test in test/billing.test.mjs that fails on BILLING-EMPTY-ORDER/F1 and passes on HEAD, then: testguard admit test/billing.test.mjs --claim BILLING-EMPTY-ORDER
  why: BILLING-EMPTY-ORDER/F1 (high) survived: "An order with no items is refused; it never produces a total." can be false with the suite green.

Where the test suite is blind, ranked. A SURVIVED fault means its defenders stayed green while the claim was false.
Do not close these by asserting current behaviour; write a test that fails on the described fault and passes on HEAD.

1. [NEW] SURVIVED  BILLING-EMPTY-ORDER/F1 (high) src/billing.mjs
   claim: An order with no items is refused; it never produces a total.
   test/billing.test.mjs stayed green with this fault applied; add an assertion that fails on it and passes on HEAD. …
```

修复 `SURVIVED` 的方法永远是写一个测试，而不是修改声明文件。为了让它消失而削弱故障，这种做法会被记录下来：`status` 会列出任何在存活之后被编辑过的故障。

### 编写测试，然后 `admit` 它

```js
// test/billing.test.mjs — add
it('refuses an order with no items', () => {
  expect(() => orderTotal({ items: [] })).toThrow('at least one item');
});
```

```bash
npx testguard-cli admit test/billing.test.mjs --claim BILLING-EMPTY-ORDER
```

```text
  killed          BILLING-EMPTY-ORDER/F1  Guard never triggers: an empty order is totalled instead of refused.

ADMITTED — test/billing.test.mjs passes on HEAD and fails on the fault of BILLING-EMPTY-ORDER, 3/3. Commit it.
evidence: .testguard/evidence-partial.json (partial; not the canonical evidence file)
```

`admit` 遵循双关卡规则：新测试必须在未修改的代码上通过，**并且**在该声明的每一个故障上都失败，三次运行三次如此。它读取你尚未 commit 的测试（它探测的是工作区的快照），`ADMITTED` 时以 `0` 退出，`NOT ADMITTED` 时以 `1` 退出，并写入部分证据，因此规范（canonical）证据文件不会被改动。

此时直接运行 `probe` 会拒绝执行。它探测的是已 commit 的 `HEAD`；如果某个守护测试已被编辑但尚未 commit，它会以 `2` 退出并停止，而不是悄悄地去测试旧文件：

```text
error: 1 defender/target file has uncommitted changes (test/billing.test.mjs); worktree mode probes HEAD (bee6ee9), so those changes would be silently ignored. Commit them, run with --include-dirty to probe the working tree, use --in-place, or --ignore-dirty if you mean HEAD as committed.
```

### Commit、探测、冻结基线

```bash
git commit -am "test: an empty order is refused"
npx testguard-cli probe         # 1 faults probed: 1 killed. — exit 0
npx testguard-cli baseline      # freeze today's unproven findings
```

```text
baseline: 0 unproven findings frozen at 47209033778e → .testguard/baseline.json
Commit this file; from now on only new findings gate.
```

基线（baseline）记录所有仍未证实的发现，因此之后的探测只会在**新的**发现上失败。这里没有未证实的内容，所以冻结的数量是零；在真实的代码库上，有了第一份基线，你就无需先修复每一个存活的故障也能采用 TestGuard。请 commit `.testguard/baseline.json`；`.testguard/` 中的其余文件会重新生成，并且已被忽略。

```bash
npx testguard-cli status        # state: clean — 1 claims / 1 faults; 1 killed; 0 new, 0 baselined
```

### 让新代码保持有声明覆盖

从这里开始，`gate` 会让任何新增了无声明源码的变更失败。添加一个没有声明的 `src/shipping.mjs`，然后运行 pre-commit 形式的命令：

```bash
npx testguard-cli gate --changed HEAD --include-dirty   # the working tree against HEAD
```

```text
gate: 1 file changed since HEAD (merge-base a847223) in the working tree; 1 evaluated, 0 excluded, 0 covered, 1 uncovered
UNCLAIMED  src/shipping.mjs  (source, nearest claim BILLING-EMPTY-ORDER)
           → testguard scaffold src/shipping.mjs --claim BILLING-EMPTY-ORDER
Next: state the claim for each UNCLAIMED file (scaffold proposes the faults), or add a testguard.ignore.json path entry with a reason that a reviewer will accept.
```

只要有一个未声明的文件，就会以 `1` 退出。在 pull request 中，同一个命令以 `gate --changed origin/main` 的形式运行。

## 你 commit 了哪些文件

| 文件 | 为什么要 commit |
|---|---|
| `testguard.claims.json` | 声明及其故障；它就是代码，要像审查代码一样审查它 |
| `.testguard/baseline.json` | 冻结的契约：你开始采用时就已经处于未证实状态的内容 |
| `.claude/skills/testguard/SKILL.md`、`.claude/settings.json`、`AGENTS.md` | 来自 `init` 的智能体层 |
| `.gitignore` | `init` 所忽略的、会重新生成的 `.testguard/` 文件 |

## 下一步

- [编写声明](../../guides/writing-claims.md)：什么样的声明值得守护，以及意图从何而来
- [在现有项目中采用 TestGuard](../../guides/existing-projects.md)：在真实代码库上运行同一个循环，并使用基线
- [GitHub Actions](../../guides/ci/github-actions.md)：在每个 pull request 上运行门禁（gate），在 main 上运行探测
- [判定结果](../../reference/verdicts.md)：每一种判定结果及其唯一的修复方式
