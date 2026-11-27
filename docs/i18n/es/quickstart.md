> 🌐 Esta es una traducción. La página en inglés es la que prevalece: [docs/quickstart.md](https://github.com/raccioly/testguard/blob/main/docs/quickstart.md). Traducido de v0.26.1.

# Inicio rápido

Esta página te lleva de cero a una primera prueba que TestGuard admitió. Toma
unos diez minutos. Es para quien prueba TestGuard por primera vez en un
proyecto JavaScript o TypeScript con una suite de vitest o jest en verde.

Primero verás cómo TestGuard encuentra un punto ciego real en el proyecto de
demostración de este repositorio. Después ejecutarás el mismo ciclo en un
proyecto pequeño tuyo. Cada bloque de salida de esta página viene de una
ejecución real. Las rutas largas se acortan con `…`.

Necesitas Node ≥ 20 y `git`. La [instalación](../../installation.md) muestra
otras formas de instalar y lo que necesita cada una.

## 1. Míralo funcionar: el fixture de respuesta conocida

El repositorio incluye un proyecto diminuto, `fixtures/known-answer/`. Produce
todos los veredictos que TestGuard puede emitir. Su prueba del registro de
auditoría verifica la fila con `expect.objectContaining({...})` y nunca nombra
el campo `content`. Por eso, si el código escribe el **secreto en crudo** en la
fila de auditoría, la suite sigue en verde.

```bash
git clone https://github.com/raccioly/testguard.git
cd testguard
npm install                                      # the fixture borrows the repository's vitest
node cli/testguard.mjs claims fixtures/known-answer   # what the fixture claims
node cli/testguard.mjs probe fixtures/known-answer    # try to falsify every claim
```

Dentro del repositorio de TestGuard, ejecutas la CLI desde el código fuente
como `node cli/testguard.mjs`. Un paquete nunca se instala en su propio
`node_modules`. En tu proyecto ejecutas `npx testguard-cli`.

El probe tarda unos segundos en este fixture y termina con código `1`:

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

Lee la primera línea. TestGuard cambió el texto enmascarado por la entrada en
crudo en `src/redact.mjs` y ejecutó tres veces la prueba de la fila de
auditoría. La prueba pasó las tres veces. Eso es `SURVIVED`: lo que sobrevivió
es la **falla** (fault), y esa es la mala noticia. Un reporte sano es casi todo
`killed`.

Los otros veredictos están ahí a propósito. El
[README](../../../fixtures/known-answer/README.md) del fixture explica cada
uno. [Veredictos](../../reference/verdicts.md) dice qué hacer con cada uno.

## 2. Tu propio proyecto

El resto de esta página ejecuta el ciclo sobre un pequeño módulo de
facturación. Si tu propio proyecto tiene una suite de vitest o jest en verde,
úsalo. Los comandos son los mismos.

Empiezas con un archivo fuente y una prueba:

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

### Instala y ejecuta `init`

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

`init` escribe los archivos que un agente de IA lee al iniciar sesión: una
skill, un hook que imprime el resumen (brief) de puntos ciegos y una sección en
`AGENTS.md`. También ignora los archivos de `.testguard/` que cada ejecución
regenera. Si no usas un agente, los archivos no hacen daño.
[Agentes de IA](../../guides/ai-agents.md) los explica. Haz commit de ellos.

### Pregunta dónde estás

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

`status` termina con `2`, porque todavía no hay nada que sondear. `init` no
crea un archivo de afirmaciones (claims). Mientras no exista uno, `claims` y
`probe` se detienen con `error: cannot read claims file testguard.claims.json`.
Empieza con un archivo de afirmaciones vacío:

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

`probe` rechaza un archivo de afirmaciones vacío con código `2`. Una ejecución
que no verificó nada no debe parecer un éxito. Mientras adoptas TestGuard en
CI, `probe --allow-empty` omite un archivo vacío válido, termina con `0` y lo
indica. Consulta
[GitHub Actions](../../guides/ci/github-actions.md#adopting-with-zero-claims).

### Deja que `scaffold` proponga fallas

```bash
npx testguard-cli scaffold src/billing.mjs    # a draft, never your claims file
```

```text
2 proposed faults in 1 draft claim for src/billing.mjs — 2 condition-forced
defendedBy prefilled from imports: test/billing.test.mjs
draft: .testguard/scaffold-billing.json
Next: Supply intended observable behavior from a requirement, ADR, bug or incident independently of the implementation: …
```

El borrador contiene propuestas mecánicas bajo un marcador `TODO-CLAIM-1`. Cada
falla es un cambio exacto en el código fuente que rompe algo:

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

Una propuesta no es una afirmación. `scaffold` lee el código. No sabe qué
**debe** hacer el código. Una afirmación escrita solo a partir del código
repite lo que el código hace hoy, con sus bugs incluidos.

### Convierte una propuesta en una afirmación

Toma la intención de una fuente distinta de la implementación, como un
requisito, un ticket o un incidente. Aquí los requisitos de facturación dicen
que el código debe rechazar un pedido vacío. Escribe esa frase, conserva la
falla correspondiente y registra de dónde viene la intención:

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

Verifica el ancla (anchor) antes de gastar un probe en ella:

```bash
npx testguard-cli claims --check-anchors    # finds every anchor and parses every replacement; runs no tests
```

```text
  BILLING-EMPTY-ORDER high     spec        1 fault   1 defender    An order with no items is refused; it never produces a total.

OK               BILLING-EMPTY-ORDER/F1  src/billing.mjs — 1 hit, expected 1; javascript syntax ok
anchor preflight: 1 faults checked, 1 ok, 0 invalid in 27ms
```

`claims` también imprime un aviso sobre anotaciones: la afirmación no tiene un
comentario `@claim` en el código fuente. El comentario es opcional y no cambia
ningún veredicto. Consulta [escribir afirmaciones](../../guides/writing-claims.md).

### Ejecuta el probe

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

El probe termina con `1`. Primero ejecutó el defensor (defender) tres veces
sobre código sin modificar. El defensor debe estar en verde, o el probe no
puede concluir nada. Después ejecutó el defensor tres veces con la guarda
desactivada. La prueba siguió en verde. Por tanto, nada en la suite verifica
que el código rechace un pedido vacío. El probe nunca tocó tu árbol de trabajo.
Aplicó la falla en un worktree temporal.

### Lee el SURVIVED

`status` y el resumen convierten la evidencia en la siguiente acción:

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

La solución para un `SURVIVED` es siempre una prueba. Nunca es una edición del
archivo de afirmaciones. TestGuard registra si debilitas una falla para que
desaparezca: `status` lista toda falla que editaste después de que sobrevivió.

### Escribe la prueba y luego pásala por `admit`

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

`admit` aplica la regla de las dos compuertas. La prueba nueva debe pasar sobre
el código sin modificar **y** fallar con cada falla de la afirmación, en tres
de tres ejecuciones. Lee tu prueba sin commit, porque sondea una instantánea
del árbol de trabajo. Termina con `0` para `ADMITTED` y con `1` para
`NOT ADMITTED`. Escribe evidencia parcial, así que el archivo canónico no
cambia.

Un `probe` normal se niega aquí. Sondea el `HEAD` con commit. Si editaste un
defensor y no hiciste commit, `probe` se detiene con código `2`. No prueba en
silencio el archivo viejo:

```text
error: 1 defender/target file has uncommitted changes (test/billing.test.mjs); worktree mode probes HEAD (bee6ee9), so those changes would be silently ignored. Commit them, run with --include-dirty to probe the working tree, use --in-place, or --ignore-dirty if you mean HEAD as committed.
```

### Haz commit, ejecuta el probe y congela una línea base

```bash
git commit -am "test: an empty order is refused"
npx testguard-cli probe         # 1 faults probed: 1 killed. — exit 0
npx testguard-cli baseline      # freeze today's unproven findings
```

```text
baseline: 0 unproven findings frozen at 47209033778e → .testguard/baseline.json
Commit this file; from now on only new findings gate.
```

Una línea base (baseline) registra cada hallazgo que sigue sin demostrarse. Los
probes posteriores fallan solo por los hallazgos **nuevos**. Aquí no hay nada
sin demostrar, así que la línea base congela cero hallazgos. En un código real,
la primera línea base te deja adoptar TestGuard sin corregir antes cada falla
sobreviviente. Haz commit de `.testguard/baseline.json`. TestGuard regenera el
resto de `.testguard/`, y `init` ya lo ignora.

```bash
npx testguard-cli status        # state: clean — 1 claims / 1 faults; 1 killed; 0 new, 0 baselined
```

### Mantén el código nuevo cubierto por afirmaciones

De aquí en adelante, `gate` hace fallar un cambio que agrega código fuente sin
afirmación. Agrega un `src/shipping.mjs` sin afirmación y ejecuta la forma
pre-commit del comando:

```bash
npx testguard-cli gate --changed HEAD --include-dirty   # the working tree against HEAD
```

```text
gate: 1 file changed since HEAD (merge-base a847223) in the working tree; 1 evaluated, 0 excluded, 0 covered, 1 uncovered
UNCLAIMED  src/shipping.mjs  (source, nearest claim BILLING-EMPTY-ORDER)
           → testguard scaffold src/shipping.mjs --claim BILLING-EMPTY-ORDER
Next: state the claim for each UNCLAIMED file (scaffold proposes the faults), or add a testguard.ignore.json path entry with a reason that a reviewer will accept.
```

Un solo archivo sin afirmación hace que el comando termine con `1`. En un pull
request, ejecuta el mismo comando como `gate --changed origin/main`.

## Lo que quedó en el commit

| Archivo | Por qué se hace commit |
|---|---|
| `testguard.claims.json` | las afirmaciones y sus fallas; revísalo como código |
| `.testguard/baseline.json` | el contrato congelado: lo que ya estaba sin demostrar cuando adoptaste TestGuard |
| `.claude/skills/testguard/SKILL.md`, `.claude/settings.json`, `AGENTS.md` | la capa de agente que crea `init` |
| `.gitignore` | los archivos regenerados de `.testguard/` que `init` ignora |

## Siguientes pasos

- [Escribir afirmaciones](../../guides/writing-claims.md): qué hace que valga la pena defender una afirmación y de dónde viene la intención
- [Adoptar TestGuard en un proyecto existente](../../guides/existing-projects.md): el mismo ciclo en un código real, con una línea base
- [GitHub Actions](../../guides/ci/github-actions.md): el gate en cada pull request y el probe en main
- [Veredictos](../../reference/verdicts.md): cada veredicto y su única solución
