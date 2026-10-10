> 🌐 Esta é uma tradução. A página em inglês é a referência oficial: [docs/quickstart.md](https://github.com/raccioly/testguard/blob/main/docs/quickstart.md). Traduzido da v0.18.3.

# Início rápido

Esta página leva você do zero a um primeiro teste admitido pelo TestGuard, em
cerca de dez minutos. Ela é para quem está experimentando o TestGuard pela
primeira vez em um projeto JavaScript ou TypeScript com uma suíte de testes
vitest ou jest verde. Primeiro você o vê encontrar um ponto cego real no
próprio projeto de demonstração do repositório; depois roda o mesmo ciclo em
um pequeno projeto seu. Cada bloco de saída abaixo foi capturado de uma
execução real; caminhos longos foram encurtados com `…`.

Você precisa de Node ≥ 20 e `git`. Outras formas de instalar, e o que cada uma
exige, estão em [instalação](../../installation.md).

## 1. Veja funcionando: a fixture known-answer

O repositório inclui um projeto minúsculo, `fixtures/known-answer/`, feito para
produzir todos os vereditos que o TestGuard pode emitir. O teste de log de
auditoria dele verifica a linha com `expect.objectContaining({...})` e nunca
menciona o campo `content`, então gravar o **segredo em claro** na linha de
auditoria mantém a suíte verde.

```bash
git clone https://github.com/raccioly/testguard.git
cd testguard
npm install                                      # the fixture borrows the repository's vitest
node cli/testguard.mjs claims fixtures/known-answer   # what the fixture claims
node cli/testguard.mjs probe fixtures/known-answer    # try to falsify every claim
```

Dentro do repositório do TestGuard você roda a CLI a partir do código-fonte,
como `node cli/testguard.mjs`, porque um pacote nunca é instalado no próprio
`node_modules`. No seu projeto, é `npx testguard-cli`.

A sondagem (probe) leva segundos nesta fixture e sai com `1`:

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

Leia a primeira linha. O TestGuard trocou o texto mascarado pela entrada em
claro em `src/redact.mjs`, rodou o teste da linha de auditoria três vezes, e
ele passou em todas. Isso é `SURVIVED`: quem sobreviveu foi a **falha injetada
(fault)**, e essa é a má notícia. Um relatório saudável é, na maior parte,
`killed`.

Os outros vereditos estão ali de propósito; o
[README](../../../fixtures/known-answer/README.md) da fixture explica cada um,
e [vereditos](../../reference/verdicts.md) diz o que fazer em cada caso.

## 2. O seu próprio projeto

O restante desta página roda o ciclo em um pequeno módulo de cobrança. Use o
seu próprio projeto se ele tiver uma suíte vitest ou jest verde; os comandos
são os mesmos.

O ponto de partida é um arquivo-fonte e um teste:

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

### Instale e rode `init`

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

O `init` grava os arquivos que um agente de IA lê no início da sessão: uma
skill, um hook que imprime o briefing de pontos cegos e uma seção no
`AGENTS.md`. Ele também ignora os arquivos de `.testguard/` que são
regenerados a cada execução. Se você não usa um agente, os arquivos são
inofensivos; [agentes de IA](../../guides/ai-agents.md) explica cada um deles.
Faça commit deles.

### Pergunte onde você está

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

O `status` sai com `2`: ainda não há nada para sondar. O `init` não cria um
arquivo de alegações (claims), e `claims` e `probe` param com
`error: cannot read claims file testguard.claims.json` até que ele exista.
Comece com um vazio:

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

O `probe` recusa um arquivo de alegações vazio com saída `2`, porque uma
execução que não verificou nada não pode parecer um sucesso. Enquanto você
adota o TestGuard no CI, `probe --allow-empty` pula um arquivo vazio válido
com saída `0` e avisa que fez isso. Veja
[GitHub Actions](../../guides/ci/github-actions.md#adopting-with-zero-claims).

### Deixe o `scaffold` propor falhas

```bash
npx testguard-cli scaffold src/billing.mjs    # a draft, never your claims file
```

```text
2 proposed faults in 1 draft claim for src/billing.mjs — 2 condition-forced
defendedBy prefilled from imports: test/billing.test.mjs
draft: .testguard/scaffold-billing.json
Next: Supply intended observable behavior from a requirement, ADR, bug or incident independently of the implementation: …
```

O rascunho guarda propostas mecânicas sob um placeholder `TODO-CLAIM-1`. Cada
falha é uma alteração exata no código-fonte que quebraria alguma coisa:

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

Uma proposta não é uma alegação. O `scaffold` leu o código; ele não sabe o que
o código **deveria** fazer, e uma alegação escrita a partir do código só
repetiria o que o código faz hoje, bugs incluídos.

### Transforme uma proposta em alegação

Tire a intenção de algum lugar que não seja a implementação: um requisito, um
ticket, um incidente. Aqui, os requisitos de cobrança dizem que um pedido
vazio deve ser recusado. Escreva essa frase, mantenha a falha correspondente e
registre de onde veio a intenção:

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

Confira a âncora antes de gastar uma sondagem com ela:

```bash
npx testguard-cli claims --check-anchors    # finds every anchor and parses every replacement; runs no tests
```

```text
  BILLING-EMPTY-ORDER high     spec        1 fault   1 defender    An order with no items is refused; it never produces a total.

OK               BILLING-EMPTY-ORDER/F1  src/billing.mjs — 1 hit, expected 1; javascript syntax ok
anchor preflight: 1 faults checked, 1 ok, 0 invalid in 27ms
```

O `claims` também imprime um aviso sobre anotação: a alegação não tem um
comentário `@claim` no código-fonte. Ele é opcional e não muda nenhum
veredito; veja [escrevendo alegações](../../guides/writing-claims.md).

### Rode o probe

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

O probe sai com `1`. Primeiro ele rodou o defensor (defender) três vezes no
código sem modificação (ele precisa estar verde, senão nada pode ser
concluído), depois três vezes com o guard desativado. O teste continuou
verde: nada na suíte verifica que um pedido vazio é recusado. A sua working
tree nunca foi tocada; a falha foi aplicada em uma git worktree temporária.

### Leia o SURVIVED

O `status` e o briefing transformam a evidência na próxima ação:

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

A correção de um `SURVIVED` é sempre um teste, nunca uma edição no arquivo de
alegações. Enfraquecer uma falha para fazê-la sumir fica registrado: o
`status` lista toda falha editada depois de ter sobrevivido.

### Escreva o teste e depois rode `admit`

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

O `admit` é a regra das duas barreiras: o novo teste precisa passar no código
sem modificação **e** falhar em cada falha injetada da alegação, em três de
três execuções. Ele lê o seu teste ainda não commitado (sonda um snapshot da
working tree), sai com `0` para `ADMITTED` e `1` para `NOT ADMITTED`, e grava
uma evidência parcial para que o arquivo canônico fique intocado.

Um `probe` simples recusaria aqui. Ele sonda o `HEAD` commitado e, com um
defensor editado mas não commitado, para com saída `2` em vez de testar
silenciosamente o arquivo antigo:

```text
error: 1 defender/target file has uncommitted changes (test/billing.test.mjs); worktree mode probes HEAD (bee6ee9), so those changes would be silently ignored. Commit them, run with --include-dirty to probe the working tree, use --in-place, or --ignore-dirty if you mean HEAD as committed.
```

### Faça commit, rode o probe, congele uma baseline

```bash
git commit -am "test: an empty order is refused"
npx testguard-cli probe         # 1 faults probed: 1 killed. — exit 0
npx testguard-cli baseline      # freeze today's unproven findings
```

```text
baseline: 0 unproven findings frozen at 47209033778e → .testguard/baseline.json
Commit this file; from now on only new findings gate.
```

Uma baseline registra cada achado que ainda não foi comprovado, para que
probes posteriores falhem só com os **novos**. Aqui nada está sem comprovação,
então ela congela zero; em uma base de código real, a primeira baseline é
como você adota o TestGuard sem precisar corrigir cada sobrevivente antes.
Faça commit de `.testguard/baseline.json`; o resto de `.testguard/` é
regenerado e já está ignorado.

```bash
npx testguard-cli status        # state: clean — 1 claims / 1 faults; 1 killed; 0 new, 0 baselined
```

### Mantenha o código novo coberto por alegações

Daqui em diante, o `gate` reprova uma mudança que adiciona código-fonte sem
alegação. Adicione um `src/shipping.mjs` sem alegação e rode a forma de
pre-commit:

```bash
npx testguard-cli gate --changed HEAD --include-dirty   # the working tree against HEAD
```

```text
gate: 1 file changed since HEAD (merge-base a847223) in the working tree; 1 evaluated, 0 excluded, 0 covered, 1 uncovered
UNCLAIMED  src/shipping.mjs  (source, nearest claim BILLING-EMPTY-ORDER)
           → testguard scaffold src/shipping.mjs --claim BILLING-EMPTY-ORDER
Next: state the claim for each UNCLAIMED file (scaffold proposes the faults), or add a testguard.ignore.json path entry with a reason that a reviewer will accept.
```

Um arquivo sem alegação sai com `1`. Em um pull request, o mesmo comando roda
como `gate --changed origin/main`.

## O que você commitou

| Arquivo | Por que ele é commitado |
|---|---|
| `testguard.claims.json` | as alegações e as falhas delas; é código, revise como código |
| `.testguard/baseline.json` | o contrato congelado: o que já estava sem comprovação quando você adotou |
| `.claude/skills/testguard/SKILL.md`, `.claude/settings.json`, `AGENTS.md` | a camada de agente criada pelo `init` |
| `.gitignore` | os arquivos regenerados de `.testguard/` que o `init` ignora |

## Próximos passos

- [Escrevendo alegações](../../guides/writing-claims.md): o que faz uma alegação valer a defesa, e de onde vem a intenção
- [Adotando o TestGuard em um projeto existente](../../guides/existing-projects.md): o mesmo ciclo em uma base de código real, com uma baseline
- [GitHub Actions](../../guides/ci/github-actions.md): o gate em cada pull request, o probe na main
- [Vereditos](../../reference/verdicts.md): cada veredito e a única correção para ele
