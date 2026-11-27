> 🌐 Esta é uma tradução. A página em inglês é a referência oficial: [README.md](https://github.com/raccioly/testguard/blob/main/README.md). Traduzido da v0.26.1.

# TestGuard

<!-- docguard:quality negation-load off — this README explains a tool defined by what must not happen; the negations are the product. -->
<!-- docguard:quality passive-voice off — verdicts and artifacts are the subjects throughout ("a fault is applied", "evidence is written"); naming an actor would misdescribe a tool nobody operates interactively. -->

[![CI](https://github.com/raccioly/testguard/actions/workflows/ci.yml/badge.svg)](https://github.com/raccioly/testguard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/testguard-cli.svg)](https://www.npmjs.com/package/testguard-cli)
[![PyPI](https://img.shields.io/pypi/v/testguard-cli.svg)](https://pypi.org/project/testguard-cli/)
[![node](https://img.shields.io/node/v/testguard-cli.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/raccioly/testguard/blob/main/LICENSE)
[![deps](https://img.shields.io/badge/runtime%20deps-1%20pinned-brightgreen.svg)](https://github.com/raccioly/testguard/blob/main/package.json)

[English](https://github.com/raccioly/testguard/blob/main/README.md) · **Português (Brasil)** · [Español](https://github.com/raccioly/testguard/blob/main/docs/i18n/es/README.md) · [简体中文](https://github.com/raccioly/testguard/blob/main/docs/i18n/zh-CN/README.md)

> Quebra o seu código de propósito e relata cada promessa que os seus testes
> não perceberam que foi quebrada.

**Não é um gerador de testes. É um verificador de alegações (claims).** A
geração de testes vem depois que uma alegação se mostra infalseável.

O TestGuard é a terceira ferramenta que segue o padrão Guard. As outras duas
são [`docguard-cli`](https://www.npmjs.com/package/docguard-cli) (docs ↔ código)
e [`websec-validator`](https://pypi.org/project/websec-validator/) (superfície
de ataque ↔ código). As três rodam o mesmo ciclo:

> declarar o que precisa ser verdade → tentar falseá-lo mecanicamente →
> congelar uma baseline → barrar só o delta → orientar o agente antes que ele
> escreva código.

## Em um minuto

**A cobertura diz que uma linha executou. Ela nunca diz que alguém conferiu o
resultado.** Uma base de código pode ter 100% de cobertura e nenhuma defesa.
Nada no CI avisa você.

Aqui está um teste real, da fixture deste repositório:

```js
expect(store.writeAudit).toHaveBeenCalledWith(
  expect.objectContaining({ action: 'MASK', scope: 'g1', ruleCount: 1 }),
);  // `content` is never named — so nothing checks it
```

`objectContaining` ignora as chaves que não lista. Troque o texto mascarado
pelo **segredo em claro** e este teste continua passando. A cobertura dessa
linha é 100%. Agora o log de auditoria vaza os dados que ele existe para
proteger.

**O método: quebre o código de propósito e observe o que os testes fazem.**

- **killed** — você quebrou o código e um teste falhou. Bom. A suíte defende
  de fato esse comportamento.
- **SURVIVED** — você quebrou o código e todos os testes continuaram verdes.
  Isso é um ponto cego.

A palavra confunde todo mundo uma vez: quem sobreviveu foi a *falha injetada*,
não o teste. **SURVIVED é a má notícia.** Um relatório saudável é cheio de
`killed`.

Mas *"os testes falharam?"* não é uma pergunta precisa. Uma suíte vermelha não
prova que houve detecção. Por isso existem sete vereditos, e cada um tem um
significado diferente:

| Veredito | O que significa |
|---|---|
| `killed` | O corpo de um teste executou e rejeitou o comportamento. O único resultado bom. |
| `SURVIVED` | Tudo passou. Um ponto cego real nos testes. |
| `NOCOVER` | Nenhum teste sequer olha para este código. Não são testes fracos: não há *nenhum* teste. |
| `UNVERIFIABLE` | Não foi possível aplicar a falha: a âncora dela mudou de lugar ou aparece duas vezes. Nada foi aprendido. |
| `FAULT-INVALID` | A própria quebra estava quebrada: ela não compilou. A culpa é nossa, não sua. |
| `TIMEOUT` | A suíte travou. Um travamento não é uma detecção. |
| `FLAKY-DEFENDER` | Em código intocado, os testes não são confiáveis o bastante para receber a pergunta. |

Quando um resultado não é claro, o TestGuard o trata como *não comprovado*.
Ele roda três vezes, não uma. Ele exige uma baseline verde antes de injetar
qualquer falha. Um timeout, uma falha de carregamento ou um resultado misto
nunca conta como kill. O design inteiro segue uma regra: **uma ferramenta que
relata tudo como detectado é pior do que ferramenta nenhuma, porque ninguém
questiona boas notícias.**

**O que não é novo:** quebrar código para testar os seus testes é *mutation
testing* (teste de mutação). Isso existe desde os anos 1970. Stryker, PIT,
mutmut e Cosmic Ray fazem isso.

**O que muda é a pergunta.** O mutation testing clássico muta tudo
mecanicamente e entrega *"mutation score: 73%"*. Esse número não é acionável
e não é auditável. Ele não diz qual promessa está em risco. O TestGuard
vincula cada falha a uma **alegação declarada**. Por isso a saída é um achado,
não um score: *"Seu projeto diz que um escopo ausente falha fechado (fail
closed). Nada verifica isso."* Essa é a diferença entre uma métrica e uma
auditoria.

📄 **[Leia o resumo técnico de seis páginas (PDF)](https://github.com/raccioly/testguard/blob/main/docs/testguard-explained.pdf)**
— a ideia na primeira página, depois as evidências de campo, a anatomia de
uma execução, os vereditos, o ciclo e a calibração dele, e os trabalhos
anteriores (prior art).

## Por quê

A cobertura não distingue um teste que fixa o comportamento *correto* de um
teste que fixa um *defeito*. Um agente que escreve o código e os testes
codifica o que ele acreditava, bugs incluídos. A suíte fica verde.

Em uma base de código de produção real, escrita inteiramente por IA, com
~4.900 testes disciplinados (sem snapshots, 0,4% sem nenhuma asserção), **a
suíte deixou passar 8 de 9 bugs históricos reais.** No pior caso, 2.451 testes
continuaram verdes sobre código sabidamente quebrado. A maior lacuna era um
caminho crítico para compliance com 100% de cobertura. A única asserção que
importava usava `expect.objectContaining({...})` e omitia o campo que
carregava os dados.

Uma segunda execução, independente, usou outra base de código escrita por IA
(63 arquivos de teste, 458 testes, 24 alegações de segurança escritas à mão,
39 falhas). **21 das 39 falhas sobreviveram a uma suíte totalmente verde, e 9
delas eram críticas.** Nenhum teste percebeu quando o bloqueio de super-admin,
as verificações de membership, as flags de cookie e todo o callback de
autorização foram desativados. Um arquivo de teste tinha reimplementado a
lógica de autorização *dentro do teste* e fazia as asserções contra a cópia.
Isso deu quinze testes verdes e zero detecção. Depois que testes no nível do
wrapper foram escritos contra as sobreviventes, as 39 de 39 falhas foram
killed.

A pesquisa revisada por pares em 2026 diz a mesma coisa pelo outro lado.
Cobertura e mutation score de suítes geradas por LLM acompanham a efetividade
apenas quando se presume que o código sob teste está correto. Quando o código
pode ter bugs, eles "no longer serve as reliable indicators" (deixam de servir
como indicadores confiáveis) ([Zhao, Zhou e Cohen, ISSTA 2026](https://arxiv.org/abs/2607.22880)).
Código com bugs leva o modelo a escrever testes que afirmam o bug. Incluir a
especificação no prompt é a mitigação que funciona ([arXiv 2607.22883](https://arxiv.org/abs/2607.22883)).
Por isso, no TestGuard, uma alegação nasce da intenção, uma falha é vinculada
à alegação, e o briefing entrega a alegação ao agente antes que ele escreva.
Além disso, os agentes saturam os testes que conseguem ver. A distância para
os testes ocultos (held-out) cresce cerca de 28 pontos a cada aumento de dez
vezes no tamanho do código ([SpecBench](https://arxiv.org/abs/2605.21384)).
Todo gerador do mercado admite um teste porque ele compila, passa e aumenta a
cobertura. O TestGuard admite um teste porque ele falha quando a alegação é
falsa.

## Instalação

| Como | Comando |
|---|---|
| npx (sem instalar) | `npx testguard-cli probe` |
| npm | `npm i -D testguard-cli` e depois `npx testguard probe` |
| pip | `pip install testguard-cli` e depois `testguard probe` (requer Node ≥ 20) |
| Homebrew | `brew tap raccioly/tap && brew install testguard` |
| GitHub Action | `uses: raccioly/testguard@v0.26.3` |
| pre-commit | `repo: https://github.com/raccioly/testguard`, hooks `testguard-claims`, `testguard-gate`, `testguard-probe` |
| GitLab CI | `include: - remote: https://raw.githubusercontent.com/raccioly/testguard/v0.26.3/packaging/gitlab/testguard.gitlab-ci.yml` |

O [guia de instalação](https://github.com/raccioly/testguard/blob/main/docs/installation.md)
cobre requisitos, instalações offline, `ENOVERSIONS` e todas as opções de CI.

## Deixe rápido

```bash
testguard probe --changed auto                 # after a change: only the claims it can affect
testguard probe --claim <ID> --confirm 1       # while writing one test: fast, provisional
testguard probe                                # nightly, or when asked: every claim
```

- As falhas já rodam em paralelo: metade das CPUs, no máximo 4 (`--serial` roda uma de cada vez).
- Uma execução isolada confirma cada kill. Assim, uma suíte que compartilha uma porta ou um banco de dados não consegue fingir um kill.
- O TestGuard reaproveita os vereditos que não mudaram. Uma execução com `--changed` ou `--claim` reaproveita o último probe completo.
- `testguard init` escreve um hook pre-push que roda o primeiro comando. `init --ci github|gitlab` escreve um job de CI que o roda nos pull requests e roda o probe completo toda noite.

Ainda está lento? `testguard status` mostra `advice` com o comando a rodar.
O checklist é [por que está lento?](https://github.com/raccioly/testguard/blob/main/docs/guides/performance.md#why-is-this-slow).

## Início rápido

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

Os códigos de saída são o contrato: `0` nada novo a provar, `1` alegações não
comprovadas, mudanças sem alegação ou âncoras de falha inválidas, `2` uma
pré-condição falhou e nada foi sondado, `3` erro de uso. Todo comando, exceto
`mcp`, aceita `--json`.

O [início rápido](https://github.com/raccioly/testguard/blob/main/docs/quickstart.md)
percorre uma primeira alegação do começo ao fim. Uma base de código que já tem
uma suíte grande tem um guia próprio:
[adotando o TestGuard em um projeto existente](https://github.com/raccioly/testguard/blob/main/docs/guides/existing-projects.md).

## Linguagens e test runners

| Linguagem | Runners | Falhas propostas pelo `scaffold` |
|---|---|---|
| JavaScript | vitest, jest, Playwright, o test runner nativo do Node | sete formas: guards forçados, instruções removidas, retornos alterados, literais enfraquecidos, chamadas removidas, campos de payload descartados, argumentos trocados |
| TypeScript | vitest, jest, Playwright (pelo transform do próprio projeto) | as mesmas sete |
| JSX, TSX (UI) | vitest, jest, Playwright | as sete, mais elementos removidos e event handlers descartados |
| Python ≥ 3.8 | pytest, ou `unittest` da stdlib quando o pytest não está presente | as mesmas sete, em sintaxe Python |
| Qualquer outra | `--runner-cmd` com um relatório JSON compatível com o jest | falhas escritas à mão |

Um teste vitest e um teste pytest podem defender a mesma alegação ao mesmo
tempo. A
[referência de linguagens e runners](https://github.com/raccioly/testguard/blob/main/docs/reference/languages-and-runners.md)
cobre resolução de runner, descoberta, mocks e limites.

Os seus testes podem precisar de flags do runner (`--runner unittest --python .venv/bin/python`,
um `--runner-cmd`, um `--node-modules`). Faça commit delas uma vez em
`testguard.config.json`. Assim, todo hook, toda linha de CI e todo agente
podem rodar apenas `testguard probe`:

```json
{ "schemaVersion": 1, "runner": "unittest", "python": ".venv/bin/python" }
```

Uma flag que você digita vale mais que o arquivo. Variáveis no estilo
`TESTGUARD_PYTHON` também valem mais que ele. `--no-config` ignora o arquivo.
As chaves e as regras estão na
[referência de configuração](https://github.com/raccioly/testguard/blob/main/docs/reference/configuration.md#testguardconfigjson-how-this-projects-tests-run).

## Use com o seu agente de IA

Um agente foi feito para conduzir o TestGuard. `testguard init` instala três
coisas: uma skill que ensina o ciclo de operação, uma seção no `AGENTS.md` e
um hook de início de sessão. O hook entrega a cada sessão os pontos cegos
ranqueados antes que o agente escreva código. Para o Claude Code, o hook em
`.claude/settings.json` é:

```json
{ "hooks": { "SessionStart": [ { "hooks": [
  { "type": "command", "command": "node_modules/.bin/testguard brief --text 2>/dev/null || { command -v testguard >/dev/null 2>&1 && testguard brief --text 2>/dev/null; } || true" }
] } ] } }
```

O hook usa primeiro a instalação do próprio projeto. Se não houver uma, ele
usa um `testguard` no `PATH`. Ele termina em `true`, então nunca quebra uma
sessão nem acessa a rede. Qualquer outro harness pode usar `testguard mcp`
(cinco ferramentas somente leitura via stdio) ou `testguard status --json`. A
configuração para Claude Code, Codex, Cursor e outros está no
[guia de agentes de IA](https://github.com/raccioly/testguard/blob/main/docs/guides/ai-agents.md).

## Documentação

| | |
|---|---|
| **Primeiros passos** | [Início rápido](https://github.com/raccioly/testguard/blob/main/docs/quickstart.md) · [Instalação](https://github.com/raccioly/testguard/blob/main/docs/installation.md) · [Atualização de versão](https://github.com/raccioly/testguard/blob/main/docs/upgrade.md) |
| **Guias** | [Projetos existentes](https://github.com/raccioly/testguard/blob/main/docs/guides/existing-projects.md) · [Projetos novos](https://github.com/raccioly/testguard/blob/main/docs/guides/new-projects.md) · [Escrevendo alegações](https://github.com/raccioly/testguard/blob/main/docs/guides/writing-claims.md) · [Agentes de IA](https://github.com/raccioly/testguard/blob/main/docs/guides/ai-agents.md) · [Python](https://github.com/raccioly/testguard/blob/main/docs/guides/python.md) · [Monorepos](https://github.com/raccioly/testguard/blob/main/docs/guides/monorepo.md) · [Desempenho](https://github.com/raccioly/testguard/blob/main/docs/guides/performance.md) · [Reproduzindo bugs que escaparam](https://github.com/raccioly/testguard/blob/main/docs/guides/replay.md) |
| **CI** | [GitHub Actions](https://github.com/raccioly/testguard/blob/main/docs/guides/ci/github-actions.md) · [GitLab CI](https://github.com/raccioly/testguard/blob/main/docs/guides/ci/gitlab.md) · [pre-commit](https://github.com/raccioly/testguard/blob/main/docs/guides/ci/pre-commit.md) |
| **Referência** | [CLI](https://github.com/raccioly/testguard/blob/main/docs/reference/cli.md) · [Linguagens e runners](https://github.com/raccioly/testguard/blob/main/docs/reference/languages-and-runners.md) · [Configuração](https://github.com/raccioly/testguard/blob/main/docs/reference/configuration.md) · [Vereditos](https://github.com/raccioly/testguard/blob/main/docs/reference/verdicts.md) · [Artefatos](https://github.com/raccioly/testguard/blob/main/docs/reference/artifacts.md) · [MCP](https://github.com/raccioly/testguard/blob/main/docs/reference/mcp.md) · [Semântica do gate](https://github.com/raccioly/testguard/blob/main/spec/GATE-SEMANTICS.md) |
| **Entenda** | [Como funciona](https://github.com/raccioly/testguard/blob/main/docs/concepts/how-it-works.md) · [Glossário](https://github.com/raccioly/testguard/blob/main/docs/glossary.md) · [FAQ](https://github.com/raccioly/testguard/blob/main/docs/faq.md) · [Solução de problemas](https://github.com/raccioly/testguard/blob/main/docs/troubleshooting.md) · [Trabalhos anteriores](https://github.com/raccioly/testguard/blob/main/docs-canonical/PRIOR-ART.md) |
| **Traduções** | [Português (Brasil)](https://github.com/raccioly/testguard/blob/main/docs/i18n/pt-BR/README.md) · [Español](https://github.com/raccioly/testguard/blob/main/docs/i18n/es/README.md) · [简体中文](https://github.com/raccioly/testguard/blob/main/docs/i18n/zh-CN/README.md) |

## O que o TestGuard não é

- **Não é um gerador de testes.** Ele julga um teste que o agente escreveu
  (`admit`). O agente continua gerando os testes.
- **Não é um dashboard de mutation score.** Ele não tem mutantes em massa,
  nem score único, nem limiar. As falhas são poucas e vinculadas a alegações
  declaradas. O TestGuard ranqueia os achados e nunca os soma.
- **Não é uma ferramenta de cobertura.** Uma linha executada não diz nada
  sobre se uma asserção perceberia a quebra. Aqui, `NOCOVER` significa que
  nenhum teste sequer importa o arquivo.
- **Não é um cliente de rede.** A CLI nunca abre um socket e não coleta
  telemetria. Ela tem uma única dependência de runtime, com versão fixada
  exata (`ajv`), exige Node ≥ 20 e usa a licença MIT.

## Experimente

O repositório inclui uma fixture de resposta conhecida (known-answer) com um
ponto cego real:

```bash
git clone https://github.com/raccioly/testguard && cd testguard && npm install
npm test                                  # includes probing the fixture end to end
```

`fixtures/known-answer/` é um projeto minúsculo. O teste da linha de auditoria
dele faz a asserção com `expect.objectContaining({...})` e omite a chave
`content`. Troque o texto mascarado pela entrada em claro e o teste continua
verde. O `probe` relata a falha como `SURVIVED`. O [README](https://github.com/raccioly/testguard/blob/main/fixtures/known-answer/README.md)
da fixture percorre cada veredito. O mesmo ponto cego em Python está em
[`fixtures/known-answer-python/`](https://github.com/raccioly/testguard/blob/main/fixtures/known-answer-python/README.md).
Ele roda tanto com o `unittest` da stdlib quanto com o `pytest`. Os dois
precisam concordar em todos os vereditos.

## Status

Catorze comandos (`status`, `init`, `claims`, `probe`, `admit`, `baseline`,
`brief`, `gate`, `scaffold`, `sweep`, `concerns`, `replay`, `clean`, `mcp`).
Runners para vitest, jest, Playwright, o test runner nativo do Node, pytest e
o `unittest` da stdlib, além de `--runner-cmd` para qualquer coisa que gere um
relatório compatível com o jest. Falhas escritas à mão e um scaffold mecânico
para JavaScript, TypeScript e Python. O contrato são catorze JSON Schemas em
[`spec/`](https://github.com/raccioly/testguard/blob/main/spec/README.md),
compartilhados com as outras ferramentas Guard. Toda release está no
[changelog](https://github.com/raccioly/testguard/blob/main/CHANGELOG.md).

Ainda não: geração de testes (`admit`, a metade de aceitação, existe; o agente
continua fazendo a metade geradora), produtores com consciência de AST e a
transferência de uma calibração entre repositórios. O `replay` já mede essa
transferência. Se ela vale para um repositório sem histórico, isso ainda não
está comprovado. Projetamos cada um desses itens e não afirmamos que nenhum
deles existe.

## Contribuindo

Aceitamos relatos de bugs, relatos de campo e correções de documentação.
Primeiro, leia o [CONTRIBUTING.md](https://github.com/raccioly/testguard/blob/main/CONTRIBUTING.md)
e o [AGENTS.md](https://github.com/raccioly/testguard/blob/main/AGENTS.md).
Para pedir ajuda, veja o [SUPPORT.md](https://github.com/raccioly/testguard/blob/main/SUPPORT.md).
Reporte vulnerabilidades de forma privada, como descrito no
[SECURITY.md](https://github.com/raccioly/testguard/blob/main/SECURITY.md).

## Licença

MIT.
