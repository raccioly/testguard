> 🌐 这是译文，以英文页面为准：[README.md](https://github.com/raccioly/testguard/blob/main/README.md)。翻译自 v0.18.3。

# TestGuard

<!-- docguard:quality negation-load off — this README explains a tool defined by what must not happen; the negations are the product. -->
<!-- docguard:quality passive-voice off — verdicts and artifacts are the subjects throughout ("a fault is applied", "evidence is written"); naming an actor would misdescribe a tool nobody operates interactively. -->

[![CI](https://github.com/raccioly/testguard/actions/workflows/ci.yml/badge.svg)](https://github.com/raccioly/testguard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/testguard-cli.svg)](https://www.npmjs.com/package/testguard-cli)
[![PyPI](https://img.shields.io/pypi/v/testguard-cli.svg)](https://pypi.org/project/testguard-cli/)
[![node](https://img.shields.io/node/v/testguard-cli.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/raccioly/testguard/blob/main/LICENSE)
[![deps](https://img.shields.io/badge/runtime%20deps-1%20pinned-brightgreen.svg)](https://github.com/raccioly/testguard/blob/main/package.json)

[English](https://github.com/raccioly/testguard/blob/main/README.md) · [Português (Brasil)](https://github.com/raccioly/testguard/blob/main/docs/i18n/pt-BR/README.md) · [Español](https://github.com/raccioly/testguard/blob/main/docs/i18n/es/README.md) · **简体中文**

> 故意破坏你的代码，并报告每一项被破坏后你的测试却没有察觉的承诺。

**不是测试生成器，而是声明（claim）验证器。** 测试生成，是在某个声明被证明不可证伪之后才发生的事。

这是遵循 Guard 模式的第三个工具，另外两个是
[`docguard-cli`](https://www.npmjs.com/package/docguard-cli)（文档 ↔ 代码）和
[`websec-validator`](https://pypi.org/project/websec-validator/)（攻击面 ↔ 代码）。三者运行的是同一个循环：

> 声明什么必须为真 → 以机械化的方式尝试证伪它 → 冻结一份基线（baseline）→
> 只对增量设门禁（gate）→ 在智能体（agent）写代码之前向它做简报（brief）。

## 一分钟了解

**覆盖率告诉你某一行被执行过，却从不告诉你有没有人检查过结果。** 因此，一个代码库可以被完全覆盖，却毫无防护，而 CI 里不会有任何提示。

下面是一个真实的测试，取自本仓库自带的夹具（fixture）：

```js
expect(store.writeAudit).toHaveBeenCalledWith(
  expect.objectContaining({ action: 'MASK', scope: 'g1', ruleCount: 1 }),
);  // `content` is never named — so nothing checks it
```

`objectContaining` 会忽略它没有列出的键。把脱敏后的文本换成**原始密钥**，这个测试依然通过。那一行的覆盖率：100%。审计日志此刻泄露的，恰恰是它本该保护的东西。

**方法：故意破坏代码，然后观察测试会怎样。**

- **killed** — 你破坏了它，有测试失败了。很好，这个行为确实受到了防护。
- **SURVIVED** — 你破坏了它，一切仍然是绿色。这是一个盲区。

这个词谁都会误解一次：存活下来的是*故障（fault）*，不是测试。**SURVIVED 是坏消息。** 健康的报告里满是 `killed`。

但 *“测试失败了吗？”* 是一个草率的问题——测试套件变红并不能证明检测到了故障。所以一共有七种判定结果（verdict），每一种的含义都不同：

| 判定结果 | 含义 |
|---|---|
| `killed` | 有测试体运行并拒绝了该行为。唯一的好结果。 |
| `SURVIVED` | 全部通过。测试中真实存在的盲区。 |
| `NOCOVER` | 根本没有测试会看这段代码。不是“测试薄弱”——而是*没有*测试。 |
| `UNVERIFIABLE` | 故障无法应用：它的锚点移动了，或者匹配了两次。没有得到任何信息。 |
| `FAULT-INVALID` | 这次破坏本身就是坏的——它无法编译。是我们的错，不是你的。 |
| `TIMEOUT` | 测试套件挂起了。挂起不算检测到。 |
| `FLAKY-DEFENDER` | 在未改动的代码上，这些测试都不够可靠，没有资格回答这个问题。 |

任何模糊情形都向*未证实*一侧取整：运行三次而不是一次；注入任何故障之前，必须先有一次全绿的基准运行；超时、加载失败或结果不一致，都绝不算作 kill。原因在于整个设计所遵循的约束——**一个把所有问题都报告为“已捕获”的工具，比没有工具更糟，因为没有人会质疑好消息。**

**并非新东西的部分**：通过破坏代码来测试你的测试，这就是*变异测试（mutation testing）*，可以追溯到 20 世纪 70 年代。Stryker、PIT、mutmut 和 Cosmic Ray 都在做这件事。

**不同之处在于所提出的问题。** 经典的变异测试会机械地变异所有代码，然后交给你一个 *“变异得分：73%”*——这个数字无法据以行动、无法审计，也无法告诉你哪一项承诺正面临风险。TestGuard 把每个故障都绑定到一条**明确陈述的声明**上，因此输出的不是一个分数，而是一项发现：*“你的项目声称缺少 scope 时会失败关闭（fail closed）。但没有任何东西检查这一点。”* 这就是指标与审计之间的区别。

📄 **[阅读六页的技术说明（PDF）](https://github.com/raccioly/testguard/blob/main/docs/testguard-explained.pdf)**
——第一页讲核心思路，随后依次是实地证据、一次运行的剖析、判定结果、循环及其校准，以及现有技术。

## 为什么

覆盖率无法区分一个锁定*正确*行为的测试和一个锁定*缺陷*的测试。一个既写代码又写测试的智能体，会把它所相信的一切——包括它的 bug——都编码进去，然后测试套件一片绿色。

在一个真实的、完全由 AI 编写的生产代码库上测量，该库有约 4,900 个规范编写的测试（没有快照测试，零断言测试仅占 0.4%）：**9 个真实的历史 bug 中有 8 个对测试套件不可见**，最坏的情况是 2,451 个测试在已知有问题的代码上全部通过。最大的缺口出现在一条覆盖率 100% 的合规关键路径上，其中唯一要紧的那个断言使用了 `expect.objectContaining({...})`，并漏掉了承载数据的那个字段。

第二次独立运行针对另一个由 AI 编写的代码库（63 个测试文件、458 个测试、24 条手写的安全声明、39 个故障）：**39 个故障中有 21 个在全绿的测试套件下存活——其中 9 个为严重级别（critical）。** 超级管理员权限把关、成员资格检查、cookie 标志，乃至整个授权回调，都可以被禁用，而没有一个测试察觉。有一个测试文件*在测试内部*重新实现了授权逻辑，并针对这份副本做断言：十五个绿色测试，零检测。针对这些存活的故障编写了包装层（wrapper）级别的测试之后，39/39 全部被 killed。

2026 年经同行评审的研究从另一面印证了同一件事。LLM 生成的测试套件，其覆盖率和变异得分只有在被测代码被假定为正确时才能反映有效性；一旦代码可能有 bug，它们就“不再是可靠的指标”（[Zhao, Zhou and Cohen, ISSTA 2026](https://arxiv.org/abs/2607.22880)）。有 bug 的代码会引导模型写出断言该 bug 的测试，而用规格说明（specification）来提示模型，是行之有效的缓解手段（[arXiv 2607.22883](https://arxiv.org/abs/2607.22883)）——这正是为什么在这里，声明来自意图，故障绑定到声明，而简报会在智能体动笔之前就把声明交给它。此外，智能体会把它能看到的测试刷到饱和，而与留出（held-out）测试之间的差距，代码规模每增长十倍就扩大约 28 个点（[SpecBench](https://arxiv.org/abs/2605.21384)）。市面上的每一个生成器接纳一个测试，是因为它能编译、能通过、能提高覆盖率。TestGuard 接纳它，是因为当声明为假时它会失败。

## 安装

| 方式 | 命令 |
|---|---|
| npx（无需安装） | `npx testguard-cli probe` |
| npm | `npm i -D testguard-cli`，然后 `npx testguard probe` |
| pip | `pip install testguard-cli`，然后 `testguard probe`（需要 Node ≥ 20） |
| Homebrew | `brew tap raccioly/tap && brew install testguard` |
| GitHub Action | `uses: raccioly/testguard@v0.18.3` |
| pre-commit | `repo: https://github.com/raccioly/testguard`，钩子 `testguard-claims`、`testguard-gate`、`testguard-probe` |
| GitLab CI | `include: - remote: https://raw.githubusercontent.com/raccioly/testguard/v0.18.3/packaging/gitlab/testguard.gitlab-ci.yml` |

环境要求、离线安装、`ENOVERSIONS` 以及所有 CI 选项，见
[安装指南](https://github.com/raccioly/testguard/blob/main/docs/installation.md)。

## 快速入门

```bash
npx testguard-cli init                      # install the agent layer at the git root
npx testguard-cli status --json             # where the project is, and the ONE next action
npx testguard-cli scaffold src/auth.ts      # propose faults for a file, as a draft to keep or drop
npx testguard-cli claims --check-anchors    # every claim is probeable before anything runs
npx testguard-cli probe                     # try to falsify each claim; report what the tests missed
npx testguard-cli admit test/auth.test.ts --claim AUTH-ADMIN   # does this test fail when the claim is false?
npx testguard-cli baseline                  # freeze today's unproven findings; only new ones gate
npx testguard-cli gate --changed origin/main # fail when a changed source file carries no claim
npx testguard-cli sweep --changed origin/main # no claims yet? report what nothing noticed in the changed files
npx testguard-cli brief --text              # tell the agent where the suite is blind, before it writes
npx testguard-cli replay --since HEAD~50..HEAD # would this suite have caught the bugs that escaped?
```

退出码就是契约：`0` 表示没有新的需要证明的内容；`1` 表示存在未证实的声明、未被声明覆盖的变更或无效的故障锚点；`2` 表示前置条件不满足，未进行任何探测；`3` 表示用法错误。除 `mcp` 外，所有命令都接受 `--json`。

[快速入门](https://github.com/raccioly/testguard/blob/main/docs/quickstart.md)会端到端地带你完成第一条声明。若要把 TestGuard 引入一个已有大型测试套件的代码库，另有专门的指南：
[在现有项目中采用 TestGuard](https://github.com/raccioly/testguard/blob/main/docs/guides/existing-projects.md)。

## 语言与测试运行器

| 语言 | 运行器 | `scaffold` 提出的故障 |
|---|---|---|
| JavaScript | vitest、jest、Playwright、Node 内置测试运行器 | 七种形态：被强制的守卫条件、被删除的语句、被篡改的返回值、被弱化的字面量、被移除的调用、被丢弃的载荷字段、被交换的参数 |
| TypeScript | vitest、jest、Playwright（通过项目自身的转换） | 同样的七种 |
| JSX、TSX（UI） | vitest、jest、Playwright | 这七种，外加被移除的元素和被丢弃的事件处理器 |
| Python ≥ 3.8 | pytest；没有 pytest 时使用标准库 `unittest` | 同样的七种，采用 Python 语法 |
| 其他任何语言 | `--runner-cmd`，配合 jest 兼容的 JSON 报告 | 手写的故障 |

一条声明可以同时由一个 vitest 测试和一个 pytest 测试来守护。运行器的解析、发现、mock 以及限制，见
[语言与运行器参考](https://github.com/raccioly/testguard/blob/main/docs/reference/languages-and-runners.md)。

## 配合你的 AI 智能体使用

TestGuard 的设计初衷就是由智能体来驱动。`testguard init` 会安装：一个讲解操作循环的技能（skill）、一段 `AGENTS.md` 章节，以及一个会话启动钩子（hook）——它会在每个会话写代码之前，用排好序的盲区为其做简报。对于 Claude Code，`.claude/settings.json` 中的钩子如下：

```json
{ "hooks": { "SessionStart": [ { "hooks": [
  { "type": "command", "command": "node_modules/.bin/testguard brief --text 2>/dev/null || { command -v testguard >/dev/null 2>&1 && testguard brief --text 2>/dev/null; } || true" }
] } ] } }
```

它先解析项目自身的安装，再查找 `PATH` 上的 `testguard`，最后以 `true` 结尾，因此它永远不会中断会话，也不会访问网络。其他任何运行框架（harness）都可以使用 `testguard mcp`（通过 stdio 提供五个只读工具）或 `testguard status --json`。Claude Code、Codex、Cursor 等工具的配置方法见
[AI 智能体指南](https://github.com/raccioly/testguard/blob/main/docs/guides/ai-agents.md)。

## 文档

| | |
|---|---|
| **入门** | [快速入门](https://github.com/raccioly/testguard/blob/main/docs/quickstart.md) · [安装](https://github.com/raccioly/testguard/blob/main/docs/installation.md) · [升级](https://github.com/raccioly/testguard/blob/main/docs/upgrade.md) |
| **指南** | [现有项目](https://github.com/raccioly/testguard/blob/main/docs/guides/existing-projects.md) · [新项目](https://github.com/raccioly/testguard/blob/main/docs/guides/new-projects.md) · [编写声明](https://github.com/raccioly/testguard/blob/main/docs/guides/writing-claims.md) · [AI 智能体](https://github.com/raccioly/testguard/blob/main/docs/guides/ai-agents.md) · [Python](https://github.com/raccioly/testguard/blob/main/docs/guides/python.md) · [Monorepo](https://github.com/raccioly/testguard/blob/main/docs/guides/monorepo.md) · [性能](https://github.com/raccioly/testguard/blob/main/docs/guides/performance.md) · [回放逃逸的 bug](https://github.com/raccioly/testguard/blob/main/docs/guides/replay.md) |
| **CI** | [GitHub Actions](https://github.com/raccioly/testguard/blob/main/docs/guides/ci/github-actions.md) · [GitLab CI](https://github.com/raccioly/testguard/blob/main/docs/guides/ci/gitlab.md) · [pre-commit](https://github.com/raccioly/testguard/blob/main/docs/guides/ci/pre-commit.md) |
| **参考** | [CLI](https://github.com/raccioly/testguard/blob/main/docs/reference/cli.md) · [语言与运行器](https://github.com/raccioly/testguard/blob/main/docs/reference/languages-and-runners.md) · [配置](https://github.com/raccioly/testguard/blob/main/docs/reference/configuration.md) · [判定结果](https://github.com/raccioly/testguard/blob/main/docs/reference/verdicts.md) · [产物](https://github.com/raccioly/testguard/blob/main/docs/reference/artifacts.md) · [MCP](https://github.com/raccioly/testguard/blob/main/docs/reference/mcp.md) · [门禁语义](https://github.com/raccioly/testguard/blob/main/spec/GATE-SEMANTICS.md) |
| **原理** | [工作原理](https://github.com/raccioly/testguard/blob/main/docs/concepts/how-it-works.md) · [术语表](https://github.com/raccioly/testguard/blob/main/docs/glossary.md) · [常见问题](https://github.com/raccioly/testguard/blob/main/docs/faq.md) · [问题排查](https://github.com/raccioly/testguard/blob/main/docs/troubleshooting.md) · [现有技术](https://github.com/raccioly/testguard/blob/main/docs-canonical/PRIOR-ART.md) |
| **译文** | [Português (Brasil)](https://github.com/raccioly/testguard/blob/main/docs/i18n/pt-BR/README.md) · [Español](https://github.com/raccioly/testguard/blob/main/docs/i18n/es/README.md) · [简体中文](https://github.com/raccioly/testguard/blob/main/docs/i18n/zh-CN/README.md) |

## TestGuard 不是什么

- **不是测试生成器。** 它评判智能体写出的测试（`admit`）；负责生成的那一半仍由智能体承担。
- **不是变异得分仪表盘。** 没有全面撒网式的变异体，没有单一分数，没有阈值。故障数量少，且都绑定到明确陈述的声明上；发现会被排序，从不加总。
- **不是覆盖率工具。** 一行代码被执行过，并不能说明断言是否会注意到问题。这里的 `NOCOVER` 意味着甚至没有任何测试导入该文件。
- **不是网络客户端。** CLI 从不打开 socket，也不收集任何遥测数据。仅有一个精确锁定版本的运行时依赖（`ajv`），Node ≥ 20，MIT 许可证。

## 动手试试

仓库自带一个含有真实盲区的已知答案夹具（known-answer fixture）：

```bash
git clone https://github.com/raccioly/testguard && cd testguard && npm install
npm test                                  # includes probing the fixture end to end
```

`fixtures/known-answer/` 是一个很小的项目，它的审计行测试使用 `expect.objectContaining({...})` 做断言，并漏掉了 `content` 键。把脱敏后的文本换成原始输入，测试仍然是绿色。`probe` 将其报告为 `SURVIVED`；该夹具的 [README](https://github.com/raccioly/testguard/blob/main/fixtures/known-answer/README.md)
逐一讲解了每种判定结果。Python 版本的同一个盲区见
[`fixtures/known-answer-python/`](https://github.com/raccioly/testguard/blob/main/fixtures/known-answer-python/README.md)，它同时在标准库 `unittest` 和 `pytest` 下运行，两者必须在每一个判定结果上保持一致。

## 现状

共十三个命令（`status`、`init`、`claims`、`probe`、`admit`、`baseline`、`brief`、`gate`、`scaffold`、`sweep`、`concerns`、`replay`、`mcp`）。支持的运行器：vitest、jest、Playwright、Node 内置测试运行器、pytest 和标准库 `unittest`，另有 `--runner-cmd` 适用于任何能输出 jest 兼容报告的工具。支持 JavaScript、TypeScript 和 Python 的手写故障与机械化脚手架（scaffold）。契约由
[`spec/`](https://github.com/raccioly/testguard/blob/main/spec/README.md) 下的十四个 JSON Schema 构成，与其他 Guard 工具共享。每个版本都记录在
[变更日志](https://github.com/raccioly/testguard/blob/main/CHANGELOG.md)中。

尚未实现：测试生成（负责接纳的那一半，即 `admit`，已经存在；负责生成的那一半仍归智能体）、感知 AST 的生成器（producer），以及校准在仓库之间的迁移。`replay` 现在已能度量这种迁移；但它能否推广到没有历史的仓库，尚未得到证实。以上每一项都在设计中有所考虑；但没有一项被宣称已经实现。

## 参与贡献

欢迎提交 bug 报告、实地使用报告和文档修正。请先阅读
[CONTRIBUTING.md](https://github.com/raccioly/testguard/blob/main/CONTRIBUTING.md)
和 [AGENTS.md](https://github.com/raccioly/testguard/blob/main/AGENTS.md)；如需帮助，请参阅 [SUPPORT.md](https://github.com/raccioly/testguard/blob/main/SUPPORT.md)；如发现安全漏洞，请按照
[SECURITY.md](https://github.com/raccioly/testguard/blob/main/SECURITY.md) 私下报告。

## 许可证

MIT。
