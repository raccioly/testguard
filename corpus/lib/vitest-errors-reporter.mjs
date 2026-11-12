// The corpus's own vitest reporter, used by corpus/derive.mjs only (never by
// TestGuard, and written without reading TestGuard's). vitest's JSON report
// keeps each error as stack text, which loses the error's class: a failed
// `expect(...).rejects` step prints as "Error: ..." though vitest threw an
// AssertionError. This reporter records, for every failed test, the raw
// `name`, `code` and `operator` of each error, so derive can apply
// GATE-SEMANTICS rule 3 to the error's shape, not its wording.
// Output (CORPUS_VITEST_ERRORS): [{ file, title: [suites..., test], errors: [{ name, code, operator }] }]
import { writeFileSync } from 'node:fs';

export default class CorpusErrorsReporter {
  onTestRunEnd(modules) {
    const out = [];
    for (const module of modules ?? []) {
      for (const test of module.children.allTests()) {
        const result = test.result();
        if (result.state !== 'failed') continue;
        const title = [];
        for (let node = test; node && node.type !== 'module'; node = node.parent) title.unshift(node.name);
        out.push({ file: module.moduleId, title, errors: (result.errors ?? []).map((e) => ({ name: e?.name ?? null, code: e?.code ?? null, operator: e?.operator ?? null })) });
      }
    }
    if (process.env.CORPUS_VITEST_ERRORS) writeFileSync(process.env.CORPUS_VITEST_ERRORS, JSON.stringify(out));
  }
}
