> 🌐 Esta es una traducción. La página en inglés es la que prevalece: [README.md](https://github.com/raccioly/testguard/blob/main/README.md). Traducido de v0.26.1.

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

> Rompe tu código a propósito e informa cada promesa que tus pruebas no
> notaron que se rompía.

**No es un generador de pruebas. Es un verificador de afirmaciones (claims).**
La generación de pruebas viene después de descubrir que una afirmación no se
puede falsear.

TestGuard es la tercera herramienta que sigue el patrón Guard. Las otras dos
son [`docguard-cli`](https://www.npmjs.com/package/docguard-cli) (docs ↔ código)
y [`websec-validator`](https://pypi.org/project/websec-validator/) (superficie
de ataque ↔ código). Las tres ejecutan un mismo ciclo:

> declarar lo que debe ser cierto → intentar falsearlo mecánicamente →
> congelar una línea base (baseline) → aplicar el control (gate) solo al
> delta → informar al agente antes de que escriba código.

## En un minuto

**La cobertura te dice que una línea se ejecutó. Nunca te dice que alguien
verificó el resultado.** Un código puede tener cobertura total y no estar
defendido en absoluto. Nada en CI te avisa.

Esta es una prueba real, tomada del fixture de este mismo repositorio:

```js
expect(store.writeAudit).toHaveBeenCalledWith(
  expect.objectContaining({ action: 'MASK', scope: 'g1', ruleCount: 1 }),
);  // `content` is never named — so nothing checks it
```

`objectContaining` ignora las claves que no enumera. Cambia el texto
enmascarado por el **secreto en crudo** y esta prueba sigue pasando. La
cobertura de esa línea es 100%. Ahora el registro de auditoría filtra los datos
que debe proteger.

**El método: rompe el código a propósito y observa qué hacen las pruebas.**

- **killed**: rompiste el código y una prueba falló. Bien. La suite defiende de
  verdad ese comportamiento.
- **SURVIVED**: rompiste el código y todas las pruebas siguieron en verde. Es un
  punto ciego.

La palabra confunde a todos una vez: lo que sobrevivió es la *falla* (fault),
no la prueba. **SURVIVED es la mala noticia.** Un reporte sano está lleno de
`killed`.

Pero *"¿fallaron las pruebas?"* no es una pregunta precisa. Una suite en rojo no
demuestra que hubo detección. Por eso hay siete veredictos, y cada uno
significa algo distinto:

| Veredicto | Qué significa |
|---|---|
| `killed` | El cuerpo de una prueba se ejecutó y rechazó el comportamiento. El único resultado bueno. |
| `SURVIVED` | Todo pasó. Un punto ciego real en las pruebas. |
| `NOCOVER` | Ninguna prueba siquiera mira este código. No son pruebas débiles: *no hay* pruebas. |
| `UNVERIFIABLE` | No se pudo aplicar la falla: su ancla (anchor) se movió o coincide dos veces. No se aprendió nada. |
| `FAULT-INVALID` | La ruptura misma estaba rota: no compiló. Culpa nuestra, no tuya. |
| `TIMEOUT` | La suite se colgó. Un cuelgue no es una detección. |
| `FLAKY-DEFENDER` | Las pruebas no son lo bastante confiables sobre código intacto como para hacerles la pregunta. |

Cuando un resultado no es claro, TestGuard lo trata como *no demostrado*. Hace
tres ejecuciones, no una. Exige una línea base en verde antes de inyectar
cualquier falla. Un timeout, un error de carga o un resultado mixto nunca
cuenta como kill. Todo el diseño sigue una regla: **una herramienta que
reporta todo como detectado es peor que no tener ninguna, porque nadie
cuestiona las buenas noticias.**

**Lo que no es nuevo:** romper código para probar tus pruebas es *mutation
testing* (pruebas de mutación). Existe desde los años setenta. Stryker, PIT,
mutmut y Cosmic Ray lo hacen.

**Lo que cambia es la pregunta.** El mutation testing clásico muta todo de forma
mecánica y te da *"puntaje de mutación: 73%"*. Ese número no se puede accionar
ni auditar. No te dice qué promesa está en riesgo. TestGuard vincula cada falla
a una **afirmación explícita**. Por eso el resultado es un hallazgo, no un
puntaje: *"Tu proyecto dice que un scope ausente falla en modo cerrado (fails
closed). Nada lo verifica."* Esa es la diferencia entre una métrica y una
auditoría.

📄 **[Lee el informe técnico de seis páginas (PDF)](https://github.com/raccioly/testguard/blob/main/docs/testguard-explained.pdf)**
— la idea en la primera página, luego la evidencia de campo, la anatomía de una
ejecución, los veredictos, el ciclo y su calibración, y los trabajos previos.

## Por qué

La cobertura no distingue entre una prueba que fija un comportamiento
*correcto* y una prueba que fija un *defecto*. Un agente que escribe el código
y sus pruebas codifica lo que creía, incluidos sus bugs. La suite queda en
verde.

Se midió un código de producción real, escrito por completo con IA, con unas
4,900 pruebas disciplinadas (sin snapshots, 0.4% sin aserciones). **La suite
no detectó 8 de 9 bugs históricos reales.** En el peor caso, 2,451 pruebas
siguieron en verde sobre código que se sabía roto. La brecha más grande fue una
ruta crítica para el cumplimiento normativo, con 100% de cobertura. La única
aserción que importaba usaba `expect.objectContaining({...})` y omitía el campo
que llevaba los datos.

Una segunda ejecución, independiente, usó otro código escrito con IA (63
archivos de prueba, 458 pruebas, 24 afirmaciones de seguridad escritas a mano,
39 fallas). **21 de 39 fallas sobrevivieron con la suite completamente en
verde, y 9 de ellas eran críticas.** Ninguna prueba lo notó cuando se
desactivaron el control de acceso de super-admin, las verificaciones de
membresía, los flags de las cookies y todo el callback de autorización. Un
archivo de pruebas había reimplementado la lógica de autorización *dentro de la
prueba* y hacía las aserciones contra la copia. Eso dio quince pruebas en verde
y cero detección. Después de escribir pruebas a nivel de wrapper contra las
fallas sobrevivientes, las 39 fallas quedaron en killed.

La investigación revisada por pares de 2026 dice lo mismo desde el otro lado.
La cobertura y el mutation score de las suites generadas por LLM reflejan la
efectividad solo cuando se asume que el código bajo prueba es correcto. Cuando
el código puede tener bugs, "ya no sirven como indicadores confiables" ([Zhao, Zhou y Cohen, ISSTA 2026](https://arxiv.org/abs/2607.22880)).
El código con bugs empuja al modelo hacia pruebas que fijan el bug. Darle la
especificación en el prompt es la mitigación que funciona ([arXiv 2607.22883](https://arxiv.org/abs/2607.22883)).
Por eso en TestGuard una afirmación nace de la intención, cada falla se vincula
a la afirmación y el resumen (brief) le da la afirmación al agente antes de que
escriba. Además, los agentes saturan cualquier prueba que puedan ver. La brecha
frente a las pruebas reservadas (held-out) crece unos 28 puntos por cada
aumento de diez veces en el tamaño del código ([SpecBench](https://arxiv.org/abs/2605.21384)).
Todos los generadores del mercado admiten una prueba porque compila, pasa y
sube la cobertura. TestGuard admite una prueba porque falla cuando la
afirmación es falsa.

## Instalación

| Cómo | Comando |
|---|---|
| npx (sin instalar) | `npx testguard-cli probe` |
| npm | `npm i -D testguard-cli` y luego `npx testguard probe` |
| pip | `pip install testguard-cli` y luego `testguard probe` (requiere Node ≥ 20) |
| Homebrew | `brew tap raccioly/tap && brew install testguard` |
| GitHub Action | `uses: raccioly/testguard@v0.26.3` |
| pre-commit | `repo: https://github.com/raccioly/testguard`, hooks `testguard-claims`, `testguard-gate`, `testguard-probe` |
| GitLab CI | `include: - remote: https://raw.githubusercontent.com/raccioly/testguard/v0.26.3/packaging/gitlab/testguard.gitlab-ci.yml` |

La [guía de instalación](https://github.com/raccioly/testguard/blob/main/docs/installation.md)
cubre los requisitos, las instalaciones sin conexión, `ENOVERSIONS` y todas las
opciones de CI.

## Hazlo rápido

```bash
testguard probe --changed auto                 # after a change: only the claims it can affect
testguard probe --claim <ID> --confirm 1       # while writing one test: fast, provisional
testguard probe                                # nightly, or when asked: every claim
```

- Las fallas ya se ejecutan en paralelo: la mitad de las CPU, como máximo 4 (`--serial` ejecuta una a la vez).
- Una ejecución en solitario confirma cada kill. Así, una suite que comparte un puerto o una base de datos no puede fingir un kill.
- TestGuard reutiliza los veredictos sin cambios. Una ejecución con `--changed` o `--claim` reutiliza el último probe completo.
- `testguard init` escribe un hook pre-push que ejecuta el primer comando. `init --ci github|gitlab` escribe un job de CI que lo ejecuta en los pull requests y ejecuta el probe completo cada noche.

¿Sigue lento? `testguard status` muestra `advice` con el comando que debes ejecutar.
La lista de comprobación es [¿por qué es lento?](https://github.com/raccioly/testguard/blob/main/docs/guides/performance.md#why-is-this-slow).

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

Los códigos de salida son el contrato: `0` no hay nada nuevo que demostrar, `1`
afirmaciones no demostradas, cambios sin afirmación o anclas de falla inválidas,
`2` falló una precondición y no se hizo ningún probe, `3` error de uso. Todos
los comandos excepto `mcp` aceptan `--json`.

El [inicio rápido](https://github.com/raccioly/testguard/blob/main/docs/quickstart.md)
recorre una primera afirmación de principio a fin. Un código que ya tiene una
suite grande tiene su propia guía:
[adoptar TestGuard en un proyecto existente](https://github.com/raccioly/testguard/blob/main/docs/guides/existing-projects.md).

## Lenguajes y runners de pruebas

| Lenguaje | Runners | Fallas que propone `scaffold` |
|---|---|---|
| JavaScript | vitest, jest, Playwright, el runner de pruebas integrado de Node | siete formas: guardas forzadas, sentencias eliminadas, valores de retorno alterados, literales debilitados, llamadas eliminadas, campos del payload descartados, argumentos intercambiados |
| TypeScript | vitest, jest, Playwright (a través de la propia transformación del proyecto) | las mismas siete |
| JSX, TSX (UI) | vitest, jest, Playwright | las siete, más elementos eliminados y manejadores de eventos descartados |
| Python ≥ 3.8 | pytest, o `unittest` de la stdlib cuando pytest no está | las mismas siete, en sintaxis de Python |
| Cualquier otro | `--runner-cmd` con un reporte JSON compatible con jest | fallas escritas a mano |

Una prueba de vitest y una prueba de pytest pueden defender una misma
afirmación al mismo tiempo. La
[referencia de lenguajes y runners](https://github.com/raccioly/testguard/blob/main/docs/reference/languages-and-runners.md)
cubre la resolución del runner, el descubrimiento, los mocks y los límites.

Tus pruebas pueden necesitar flags del runner (`--runner unittest --python .venv/bin/python`,
un `--runner-cmd`, un `--node-modules`). Haz commit de ellos una sola vez en
`testguard.config.json`. Así, cada hook, cada línea de CI y cada agente pueden
ejecutar solo `testguard probe`:

```json
{ "schemaVersion": 1, "runner": "unittest", "python": ".venv/bin/python" }
```

Un flag que escribes tiene prioridad sobre el archivo. Las variables del estilo
`TESTGUARD_PYTHON` también tienen prioridad sobre él. `--no-config` ignora el
archivo. Las claves y las reglas están en la
[referencia de configuración](https://github.com/raccioly/testguard/blob/main/docs/reference/configuration.md#testguardconfigjson-how-this-projects-tests-run).

## Úsalo con tu agente de IA

Un agente está pensado para manejar TestGuard. `testguard init` instala tres
cosas: una skill que enseña el ciclo de operación, una sección en `AGENTS.md` y
un hook de inicio de sesión. El hook entrega a cada sesión los puntos ciegos
ordenados por prioridad antes de que el agente escriba código. Para Claude Code,
el hook en `.claude/settings.json` es:

```json
{ "hooks": { "SessionStart": [ { "hooks": [
  { "type": "command", "command": "node_modules/.bin/testguard brief --text 2>/dev/null || { command -v testguard >/dev/null 2>&1 && testguard brief --text 2>/dev/null; } || true" }
] } ] } }
```

El hook usa primero la instalación propia del proyecto. Si no hay ninguna, usa
un `testguard` del `PATH`. Termina en `true`, así que nunca puede romper una
sesión ni acceder a la red. Cualquier otro harness puede usar `testguard mcp`
(cinco herramientas de solo lectura sobre stdio) o `testguard status --json`.
La configuración para Claude Code, Codex, Cursor y otros está en la
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
  (`admit`). El agente sigue generando las pruebas.
- **No es un panel de mutation score.** No tiene mutantes en masa, ni un puntaje
  único, ni un umbral. Las fallas son pocas y están vinculadas a afirmaciones
  explícitas. TestGuard ordena los hallazgos por prioridad y nunca los suma.
- **No es una herramienta de cobertura.** Que una línea se haya ejecutado no
  dice nada sobre si una aserción lo notaría. Aquí `NOCOVER` significa que
  ninguna prueba siquiera importa el archivo.
- **No es un cliente de red.** La CLI nunca abre un socket y no recopila
  telemetría. Tiene una sola dependencia en tiempo de ejecución, fijada a una
  versión exacta (`ajv`), necesita Node ≥ 20 y usa la licencia MIT.

## Pruébalo

El repositorio incluye un fixture de respuesta conocida (known-answer) con un
punto ciego real:

```bash
git clone https://github.com/raccioly/testguard && cd testguard && npm install
npm test                                  # includes probing the fixture end to end
```

`fixtures/known-answer/` es un proyecto diminuto. Su prueba de la fila de
auditoría hace la aserción con `expect.objectContaining({...})` y omite la
clave `content`. Cambia el texto enmascarado por la entrada en crudo y la
prueba sigue en verde. `probe` reporta la falla como `SURVIVED`. El
[README](https://github.com/raccioly/testguard/blob/main/fixtures/known-answer/README.md)
del fixture recorre cada veredicto. El mismo punto ciego en Python está en
[`fixtures/known-answer-python/`](https://github.com/raccioly/testguard/blob/main/fixtures/known-answer-python/README.md).
Se ejecuta tanto con `unittest` de la stdlib como con `pytest`. Ambos deben
coincidir en cada veredicto.

## Estado

Catorce comandos (`status`, `init`, `claims`, `probe`, `admit`, `baseline`,
`brief`, `gate`, `scaffold`, `sweep`, `concerns`, `replay`, `clean`, `mcp`).
Runners para vitest, jest, Playwright, el runner de pruebas integrado de Node,
pytest y `unittest` de la stdlib, más `--runner-cmd` para cualquier cosa que
escriba un reporte compatible con jest. Fallas escritas a mano y un scaffold
mecánico para JavaScript, TypeScript y Python. El contrato son catorce JSON
Schemas bajo [`spec/`](https://github.com/raccioly/testguard/blob/main/spec/README.md),
compartidos con las demás herramientas Guard. Cada versión publicada está en el
[changelog](https://github.com/raccioly/testguard/blob/main/CHANGELOG.md).

Todavía no existen: la generación de pruebas (la mitad de aceptación, `admit`,
existe; el agente sigue haciendo la mitad que genera), los productores que
entiendan el AST y la transferencia de una calibración entre repositorios.
`replay` ya mide esa transferencia. No está demostrado que funcione en un
repositorio sin historial. Diseñamos para cada una de estas funciones y no
afirmamos que ninguna esté lograda.

## Contribuir

Agradecemos los reportes de bugs, los reportes de campo y las correcciones a la
documentación. Primero lee
[CONTRIBUTING.md](https://github.com/raccioly/testguard/blob/main/CONTRIBUTING.md)
y [AGENTS.md](https://github.com/raccioly/testguard/blob/main/AGENTS.md).
Para obtener ayuda, consulta [SUPPORT.md](https://github.com/raccioly/testguard/blob/main/SUPPORT.md).
Reporta las vulnerabilidades de forma privada, como describe
[SECURITY.md](https://github.com/raccioly/testguard/blob/main/SECURITY.md).

## Licencia

MIT.
