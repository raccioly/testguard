# Quillbird Newsletter Toolkit

A small library for preparing issues of the fictional "Quillbird Weekly" newsletter. All behavior below is deterministic and uses only the inputs stated.

## Placeholder Substitution

R1. An operation named render takes a template string and a map of names to string values. Every occurrence of `{{name}}` (name made of letters, digits and underscores, with optional spaces inside the braces, so `{{ name }}` is equivalent) is replaced by the value for that name. Text outside placeholders is copied unchanged. Example: template `Hi {{who}}!` with who = `Ann` yields `Hi Ann!`.

R2. By default the substituted value is HTML-escaped: `&` becomes `&amp;`, `<` becomes `&lt;`, `>` becomes `&gt;`, `"` becomes `&quot;`, and `'` becomes `&#39;`. The raw form `{{{name}}}` (three braces) inserts the value unescaped. Example: value `<b>&` renders as `&lt;b&gt;&amp;` with `{{x}}` and as `<b>&` with `{{{x}}}`.

R3. A placeholder whose name is absent from the map, in strict mode (the default), makes render fail with an error named `MissingValueError` whose message is `missing value: <name>` (for example `missing value: who`). In lenient mode, the placeholder is replaced by an empty string instead. A name present with an empty-string value is not missing.

R4. Substituted values are never re-scanned: a value containing `{{other}}` appears literally in the output. A template containing an unclosed `{{` (no matching `}}`) fails with `TemplateSyntaxError` whose message is `unclosed placeholder at position <n>`, where n is the zero-based index of the opening `{{`.

## Slug Generation

R5. An operation named slugify takes a title and returns a URL slug: lowercase the text, replace every run of characters other than a-z and 0-9 with a single hyphen, and remove leading and trailing hyphens. Example: `Hello, World! 2024` yields `hello-world-2024`.

R6. Accented Latin letters are first reduced to their base letter (`Café` becomes `cafe`). If the result is empty (for example the title `!!!`), slugify fails with `EmptySlugError` whose message is `title produces an empty slug`.

R7. slugify accepts an optional maximum length (positive integer, default 60). A slug longer than the limit is cut at the limit and then any trailing hyphen is removed. Example: `alpha-beta-gamma` with limit 11 yields `alpha-beta`. A limit below 1 fails with `InvalidLimitError` whose message is `limit must be at least 1`.

## Reading Time

R8. An operation named countWords takes text and returns the number of words, where a word is a maximal run of non-whitespace characters. Text that is empty or only whitespace returns 0. Example: `  one  two\nthree ` returns 3.

R9. An operation named readingTime takes a word count and a reader class, either `skimmer` (400 words per minute) or `careful` (200 words per minute). It returns whole minutes, rounded up, with a minimum of 1 minute for any count of 1 or more, and 0 for a count of 0. Examples: 401 words as skimmer returns 2; 200 words as careful returns 1; 201 words as careful returns 2.

R10. A negative or non-integer word count fails with `InvalidCountError` whose message is `count must be a non-negative integer`. An unknown reader class fails with `UnknownReaderError` whose message is `unknown reader: <class>`.

## Send Scheduling

R11. An operation named nextSend takes a reference date-time (UTC), a set of send days chosen from `mon` through `sun`, and a send time of day `HH:MM` (UTC, 24-hour). It returns the earliest send instant that is strictly after the reference. Example: reference Wednesday 2025-01-15 09:00, days {mon, wed}, time 08:30 returns Monday 2025-01-20 08:30; with time 09:30 it returns Wednesday 2025-01-15 09:30.

R12. A reference exactly equal to a send instant is not eligible, so the next send is returned. Example: reference Monday 2025-01-20 08:30, days {mon}, time 08:30 returns Monday 2025-01-27 08:30.

R13. An empty set of days fails with `EmptyScheduleError` whose message is `at least one send day is required`. A day name outside `mon` through `sun` fails with `InvalidDayError` whose message is `invalid day: <value>`. A time not matching a valid 24-hour `HH:MM` (for example `24:00` or `9:5`) fails with `InvalidTimeError` whose message is `invalid time: <value>`.

## Audience-Specific Footer

R14. An operation named footer takes a recipient with a `kind` of `subscriber` or `guest`. For a subscriber with name N, it returns `Thanks for reading, N. Unsubscribe anytime.` For a guest, it returns `Enjoying Quillbird? Subscribe at quillbird.example/join.` and ignores any name supplied. Any other kind fails with `UnknownRecipientError` whose message is `unknown recipient kind: <kind>`.
