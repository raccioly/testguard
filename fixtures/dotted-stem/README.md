# Fixture: a dotted stem

`src/session.ts` imports `./auth.config`, which is `src/auth.config.ts`: the
dot is part of the file's name, not an extension. The import closure must follow
it, so a docs-only change selects no claim here (#301).
