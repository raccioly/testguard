> 🌐 Esta es una traducción. La página en inglés es la que prevalece: [README.md](https://github.com/raccioly/testguard/blob/main/README.md). Traducido de v0.18.3.

# TestGuard

<!-- docguard:quality negation-load off — this README explains a tool defined by what must not happen; the negations are the product. -->
<!-- docguard:quality passive-voice off — verdicts and artifacts are the subjects throughout ("a fault is applied", "evidence is written"); naming an actor would misdescribe a tool nobody operates interactively. -->

[![CI](https://github.com/raccioly/testguard/actions/workflows/ci.yml/badge.svg)](https://github.com/raccioly/testguard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/testguard-cli.svg)](https://www.npmjs.com/package/testguard-cli)
[![PyPI](https://img.shields.io/pypi/v/testguard-cli.svg)](https://pypi.org/project/testguard-cli/)
[![node](https://img.shields.io/node/v/testguard-cli.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/raccioly/testguard/blob/main/LICENSE)
[![deps](https://img.shields.io/badge/runtime%20deps-1%20pinned-brightgreen.svg)](https://github.com/raccioly/testguard/blob/main/package.json)

[English](https://github.com/raccioly/testguard/blob/main/README.md) · [Português (Brasil)](https://github.com/raccioly/testguard/blob/main/docs/i18n/pt-BR/README.md) · **Español** · [简体中文](https://github.com/raccioly/testguard/blob/main/docs/i18n/zh-CN/README.md)

> Rompe tu código a propósito y reporta cada promesa que tus pruebas no
> notaron que se rompía.

**No es un generador de pruebas. Es un verificador de afirmaciones (claims).**
La generación de pruebas es lo que viene después de descubrir que una
afirmación no es falsable.

Es la tercera herramienta que sigue el patrón Guard, junto a
[`docguard-cli`](https://www.npmjs.com/package/docguard-cli) (docs ↔ código) y
[`websec-validator`](https://pypi.org/project/websec-validator/) (superficie
de ataque ↔ código). Las tres ejecutan un mismo ciclo:

> declarar lo que debe ser cierto → intentar falsearlo mecánicamente →
> congelar una línea base (baseline) → aplicar el control (gate) solo al
> delta → informar al agente antes de que escriba código.

## En un minuto

**La cobertura te dice que una línea se ejecutó. Nunca te dice que alguien
verificó el resultado.** Así, un código puede tener cobertura total y estar
completamente indefenso, y nada en CI va a decir una palabra.

Esta es una prueba real, tomada del fixture de este mismo repositorio:

```js
expect(store.writeAudit).toHaveBeenCalledWith(
  expect.objectContaining({ action: 'MASK', scope: 'g1', ruleCount: 1 }),
);  // `content` is never named — so nothing checks it
```

`objectContaining` ignora las claves que no enumera. Cambia el texto
enmascarado por el **secreto en crudo** y esta prueba sigue pasando.
Cobertura de esa línea: 100%. El registro de auditoría ahora filtra justamente
lo que existe para proteger.

**El método: romper el código deliberadamente y luego observar qué hacen las
pruebas.**

- **killed**: lo rompiste y una prueba falló. Bien. Ese comportamiento está
  defendido de verdad.
- **SURVIVED**: lo rompiste y todo siguió en verde. Un punto ciego.

La palabra confunde a todos la primera vez: lo que sobrevivió es la *falla*
(fault), no la prueba. **SURVIVED es la mala noticia.** Un reporte sano está
lleno de `killed`.

Pero *"¿fallaron las pruebas?"* es una pregunta imprecisa: una suite en rojo
no demuestra que hubo detección. Por eso hay siete veredictos, y cada uno
significa algo distinto:

| Veredicto | Qué significa |
|---|---|
| `killed` | El cuerpo de una prueba se ejecutó y rechazó el comportamiento. El único resultado bueno. |
| `SURVIVED` | Todo pasó. Un punto ciego real en las pruebas. |
| `NOCOVER` | Ninguna prueba siquiera mira este código. No son "pruebas débiles": *no hay* pruebas. |
| `UNVERIFIABLE` | La falla no se pudo aplicar: su ancla (anchor) se movió o coincide dos veces. No se aprendió nada. |
| `FAULT-INVALID` | La ruptura misma estaba rota: no compilaba. Culpa nuestra, no tuya. |
| `TIMEOUT` | La suite se colgó. Un cuelgue no es una detección. |
| `FLAKY-DEFENDER` | Las pruebas no son lo bastante confiables sobre código intacto como para hacerles la pregunta. |

Toda ambigüedad se redondea hacia *no demostrado*: tres ejecuciones en lugar
de una, una ejecución de referencia en verde obligatoria antes de inyectar
cualquier falla, y un timeout, un error de carga o un resultado mixto nunca
cuentan como kill. La razón es la restricción de la que se deriva todo el
diseño: **una herramienta que reporta todo como detectado es peor que no tener
ninguna, porque nadie cuestiona las buenas noticias.**

**Lo que no es nuevo:** romper código para probar tus pruebas es *mutation
testing* (pruebas de mutación), y data de los años setenta. Stryker, PIT,
mutmut y Cosmic Ray lo hacen.

**Lo que cambia es la pregunta.** El mutation testing clásico muta todo
mecánicamente y te entrega *"puntaje de mutación: 73%"*: un número que no es
accionable, no es auditable y no puede decirte qué promesa está en riesgo.
TestGuard vincula cada falla a una **afirmación explícita**, así que el
resultado no es un puntaje sino un hallazgo: *"Tu proyecto dice que un scope
ausente falla en modo cerrado (fails closed). Nada lo verifica."* Esa es la
diferencia entre una métrica y una auditoría.

📄 **[Lee el informe técnico de seis páginas (PDF)](https://github.com/raccioly/testguard/blob/main/docs/testguard-explained.pdf)**
— la idea en la primera página, luego la evidencia de campo, la anatomía de
una ejecución, los veredictos, el ciclo y su calibración, y los trabajos
previos.

## Por qué

La cobertura no distingue entre una prueba que fija un comportamiento
*correcto* y una que fija un *defecto*. Un agente que escribe tanto el código
como sus pruebas codifica lo que sea que creía, incluidos sus bugs, y la suite
queda en verde.

Medido en un código de producción real, escrito íntegramente por IA, con
~4,900 pruebas disciplinadas (sin snapshots, 0.4% sin aserciones): **8 de 9
bugs históricos reales eran invisibles para la suite**; en el peor caso, 2,451
pruebas en verde sobre código que se sabía roto. La brecha más grande fue una
ruta crítica para el cumplimiento normativo con 100% de cobertura, donde la
única aserción que importaba usaba `expect.objectContaining({...})` y omitía el
campo que llevaba los datos.

Una segunda ejecución, independiente, sobre otro código escrito por IA (63
archivos de prueba, 458 pruebas, 24 afirmaciones de seguridad escritas a mano,
39 fallas): **21 de 39 fallas sobrevivieron con la suite completamente en
verde, 9 de ellas críticas.** El control de acceso de super-admin, las
verificaciones de membresía, los flags de las cookies y todo el callback de
autorización podían desactivarse sin que una sola prueba lo notara. Un archivo
de pruebas había reimplementado la lógica de autorización *dentro de la
prueba* y hacía las aserciones contra la copia: quince pruebas en verde, cero
detección. Después de escribir pruebas a nivel de wrapper contra las
sobrevivientes, las 39/39 quedaron en killed.

La literatura revisada por pares de 2026 dice lo mismo desde el otro lado. La
cobertura y el mutation score de las suites generadas por LLM reflejan la
efectividad solo cuando se asume que el código bajo prueba es correcto; cuando
puede tener bugs, "ya no sirven como indicadores confiables" ([Zhao, Zhou y Cohen, ISSTA 2026](https://arxiv.org/abs/2607.22880)).
El código con bugs empuja al modelo hacia pruebas cuyas aserciones fijan el
bug, y darle la especificación en el prompt es la mitigación que funciona ([arXiv 2607.22883](https://arxiv.org/abs/2607.22883));
por eso aquí una afirmación nace de la intención, cada falla está vinculada a
la afirmación y el resumen (brief) le entrega la afirmación al agente antes de
que escriba. Además, los agentes saturan cualquier prueba que puedan ver, y la
brecha frente a las pruebas reservadas (held-out) crece unos 28 puntos por
cada aumento de diez veces en el tamaño del código ([SpecBench](https://arxiv.org/abs/2605.21384)).
Todos los generadores del mercado admiten una prueba porque compila, pasa y
sube la cobertura. TestGuard la admite porque falla cuando la afirmación es
falsa.

## Instalación

| Cómo | Comando |
|---|---|
| npx (sin instalar) | `npx testguard-cli probe` |
| npm | `npm i -D testguard-cli` y luego `npx testguard probe` |
| pip | `pip install testguard-cli` y luego `testguard probe` (requiere Node ≥ 20) |
| Homebrew | `brew tap raccioly/tap && brew install testguard` |
| GitHub Action | `uses: raccioly/testguard@v0.18.3` |
| pre-commit | `repo: https://github.com/raccioly/testguard`, hooks `testguard-claims`, `testguard-gate`, `testguard-probe` |
| GitLab CI | `include: - remote: https://raw.githubusercontent.com/raccioly/testguard/v0.18.3/packaging/gitlab/testguard.gitlab-ci.yml` |

Los requisitos, las instalaciones sin conexión, `ENOVERSIONS` y todas las
opciones de CI están en la
[guía de instalación](https://github.com/raccioly/testguard/blob/main/docs/installation.md).

## Inicio rápido

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

Los códigos de salida son el contrato: `0` no hay nada nuevo que demostrar;
`1` afirmaciones no demostradas, cambios sin afirmación o anclas de falla
inválidas; `2` falló una precondición y no se sondeó nada; `3` error de uso.
Todos los comandos excepto `mcp` aceptan `--json`.

El [inicio rápido](https://github.com/raccioly/testguard/blob/main/docs/quickstart.md)
recorre una primera afirmación de principio a fin. Incorporar TestGuard a un
código que ya tiene una suite grande tiene su propia guía:
[adoptar TestGuard en un proyecto existente](https://github.com/raccioly/testguard/blob/main/docs/guides/existing-projects.md).

## Lenguajes y runners de pruebas

| Lenguaje | Runners | Fallas que propone `scaffold` |
|---|---|---|
| JavaScript | vitest, jest, Playwright, el runner de pruebas integrado de Node | siete formas: guardas forzadas, sentencias eliminadas, valores de retorno alterados, literales debilitados, llamadas eliminadas, campos del payload descartados, argumentos intercambiados |
| TypeScript | vitest, jest, Playwright (a través de la propia transformación del proyecto) | las mismas siete |
| JSX, TSX (UI) | vitest, jest, Playwright | las siete, más elementos eliminados y manejadores de eventos descartados |
| Python ≥ 3.8 | pytest, o `unittest` de la stdlib cuando pytest no está | las mismas siete, en sintaxis de Python |
| Cualquier otro | `--runner-cmd` con un reporte JSON compatible con jest | fallas escritas a mano |

Una misma afirmación puede estar defendida a la vez por una prueba de vitest y
una de pytest. La resolución del runner, el descubrimiento, los mocks y los
límites están en la
[referencia de lenguajes y runners](https://github.com/raccioly/testguard/blob/main/docs/reference/languages-and-runners.md).

## Úsalo con tu agente de IA

TestGuard está pensado para que lo maneje un agente. `testguard init` instala
una skill que enseña el ciclo de operación, una sección en `AGENTS.md` y un
hook de inicio de sesión que, antes de que se escriba código, informa a cada
sesión de los puntos ciegos ordenados por prioridad. Para Claude Code, el hook
en `.claude/settings.json` es:

```json
{ "hooks": { "SessionStart": [ { "hooks": [
  { "type": "command", "command": "node_modules/.bin/testguard brief --text 2>/dev/null || { command -v testguard >/dev/null 2>&1 && testguard brief --text 2>/dev/null; } || true" }
] } ] } }
```

Primero busca la instalación propia del proyecto, luego un `testguard` en el
`PATH`, y termina en `true`, así que nunca puede romper una sesión ni acceder a
la red. Cualquier otro harness puede usar `testguard mcp` (cinco herramientas
de solo lectura sobre stdio) o `testguard status --json`. La configuración
para Claude Code, Codex, Cursor y otros está en la
[guía de agentes de IA](https://github.com/raccioly/testguard/blob/main/docs/guides/ai-agents.md).

## Documentación

| | |
|---|---|
| **Primeros pasos** | [Inicio rápido](https://github.com/raccioly/testguard/blob/main/docs/quickstart.md) · [Instalación](https://github.com/raccioly/testguard/blob/main/docs/installation.md) · [Actualización](https://github.com/raccioly/testguard/blob/main/docs/upgrade.md) |
| **Guías** | [Proyectos existentes](https://github.com/raccioly/testguard/blob/main/docs/guides/existing-projects.md) · [Proyectos nuevos](https://github.com/raccioly/testguard/blob/main/docs/guides/new-projects.md) · [Escribir afirmaciones](https://github.com/raccioly/testguard/blob/main/docs/guides/writing-claims.md) · [Agentes de IA](https://github.com/raccioly/testguard/blob/main/docs/guides/ai-agents.md) · [Python](https://github.com/raccioly/testguard/blob/main/docs/guides/python.md) · [Monorepos](https://github.com/raccioly/testguard/blob/main/docs/guides/monorepo.md) · [Rendimiento](https://github.com/raccioly/testguard/blob/main/docs/guides/performance.md) · [Reproducir bugs que se escaparon](https://github.com/raccioly/testguard/blob/main/docs/guides/replay.md) |
| **CI** | [GitHub Actions](https://github.com/raccioly/testguard/blob/main/docs/guides/ci/github-actions.md) · [GitLab CI](https://github.com/raccioly/testguard/blob/main/docs/guides/ci/gitlab.md) · [pre-commit](https://github.com/raccioly/testguard/blob/main/docs/guides/ci/pre-commit.md) |
| **Referencia** | [CLI](https://github.com/raccioly/testguard/blob/main/docs/reference/cli.md) · [Lenguajes y runners](https://github.com/raccioly/testguard/blob/main/docs/reference/languages-and-runners.md) · [Configuración](https://github.com/raccioly/testguard/blob/main/docs/reference/configuration.md) · [Veredictos](https://github.com/raccioly/testguard/blob/main/docs/reference/verdicts.md) · [Artefactos](https://github.com/raccioly/testguard/blob/main/docs/reference/artifacts.md) · [MCP](https://github.com/raccioly/testguard/blob/main/docs/reference/mcp.md) · [Semántica del gate](https://github.com/raccioly/testguard/blob/main/spec/GATE-SEMANTICS.md) |
| **Entender** | [Cómo funciona](https://github.com/raccioly/testguard/blob/main/docs/concepts/how-it-works.md) · [Glosario](https://github.com/raccioly/testguard/blob/main/docs/glossary.md) · [Preguntas frecuentes](https://github.com/raccioly/testguard/blob/main/docs/faq.md) · [Solución de problemas](https://github.com/raccioly/testguard/blob/main/docs/troubleshooting.md) · [Trabajos previos](https://github.com/raccioly/testguard/blob/main/docs-canonical/PRIOR-ART.md) |
| **Traducciones** | [Português (Brasil)](https://github.com/raccioly/testguard/blob/main/docs/i18n/pt-BR/README.md) · [Español](https://github.com/raccioly/testguard/blob/main/docs/i18n/es/README.md) · [简体中文](https://github.com/raccioly/testguard/blob/main/docs/i18n/zh-CN/README.md) |

## Lo que TestGuard no es

- **No es un generador de pruebas.** Juzga una prueba que escribió el agente
  (`admit`); la mitad que genera queda en manos del agente.
- **No es un panel de mutation score.** Nada de mutantes en masa, ni un
  puntaje único, ni un umbral. Las fallas son pocas y están vinculadas a
  afirmaciones explícitas; los hallazgos se ordenan por prioridad, nunca se
  suman.
- **No es una herramienta de cobertura.** Que una línea se haya ejecutado no
  dice nada sobre si una aserción lo notaría. Aquí `NOCOVER` significa que
  ninguna prueba siquiera importa el archivo.
- **No es un cliente de red.** La CLI nunca abre un socket y no recopila
  telemetría. Una sola dependencia en tiempo de ejecución, fijada a una versión
  exacta (`ajv`), Node ≥ 20, MIT.

## Pruébalo

El repositorio incluye un fixture de respuesta conocida (known-answer) con un
punto ciego real:

```bash
git clone https://github.com/raccioly/testguard && cd testguard && npm install
npm test                                  # includes probing the fixture end to end
```

`fixtures/known-answer/` es un proyecto diminuto cuya prueba de la fila de
auditoría hace la aserción con `expect.objectContaining({...})` y omite la
clave `content`. Cambia el texto enmascarado por la entrada en crudo y la
prueba sigue en verde. `probe` lo reporta como `SURVIVED`; el
[README](https://github.com/raccioly/testguard/blob/main/fixtures/known-answer/README.md)
del fixture recorre cada veredicto. El mismo punto ciego en Python está en
[`fixtures/known-answer-python/`](https://github.com/raccioly/testguard/blob/main/fixtures/known-answer-python/README.md),
que se ejecuta tanto con `unittest` de la stdlib como con `pytest`, y ambos
deben coincidir en cada veredicto.

## Estado

Trece comandos (`status`, `init`, `claims`, `probe`, `admit`, `baseline`,
`brief`, `gate`, `scaffold`, `sweep`, `concerns`, `replay`, `mcp`). Runners
para vitest, jest, Playwright, el runner de pruebas integrado de Node, pytest
y `unittest` de la stdlib, más `--runner-cmd` para cualquier cosa que escriba
un reporte compatible con jest. Fallas escritas a mano y un scaffold mecánico
para JavaScript, TypeScript y Python. El contrato son catorce JSON Schemas
bajo [`spec/`](https://github.com/raccioly/testguard/blob/main/spec/README.md),
compartidos con las demás herramientas Guard. Cada versión publicada está en
el [changelog](https://github.com/raccioly/testguard/blob/main/CHANGELOG.md).

Todavía no: generación de pruebas (la mitad de aceptación, `admit`, existe; la
mitad generadora sigue siendo del agente), productores que entiendan el AST y
la transferencia de una calibración entre repositorios. `replay` ya mide esa
transferencia; no está demostrado que se sostenga en un repositorio sin
historial. Todo esto está contemplado en el diseño; nada de ello se da por
logrado.

## Contribuir

Se agradecen los reportes de bugs, los reportes de campo y las correcciones a
la documentación. Lee primero
[CONTRIBUTING.md](https://github.com/raccioly/testguard/blob/main/CONTRIBUTING.md)
y [AGENTS.md](https://github.com/raccioly/testguard/blob/main/AGENTS.md); para
obtener ayuda, consulta [SUPPORT.md](https://github.com/raccioly/testguard/blob/main/SUPPORT.md),
y reporta vulnerabilidades de forma privada según
[SECURITY.md](https://github.com/raccioly/testguard/blob/main/SECURITY.md).

## Licencia

MIT.
