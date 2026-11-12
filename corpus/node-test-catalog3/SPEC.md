# Shelfmark: A Three-Part Library Catalog Tool

Shelfmark is made of three separately published parts. Core defines catalog records. Search indexes Core records and answers queries. Report builds summaries from Search results and Core records. Each requirement below names the part that owns it.

## Core

**R1. (Core) ISBN-13 validation.** A string is a valid ISBN-13 only if, after removing hyphens and spaces, it is exactly 13 digits and its check digit is correct. The check digit is correct when the first 12 digits, weighted alternately 1 and 3 starting with 1, plus the 13th digit, sum to a multiple of 10. "9780306406157" is valid. "9780306406158" is invalid. "978-0-306-40615-7" is valid and normalizes to "9780306406157".

**R2. (Core) Invalid ISBN rejection.** Creating a record with an invalid ISBN fails with an error named `InvalidIsbnError`. This applies to wrong length, non-digit characters (such as the letter "X" in any position), and a wrong check digit. The error message is `Invalid ISBN-13: ` followed by the original input unchanged.

**R3. (Core) Title normalization.** A stored title has leading and trailing whitespace removed and every internal run of whitespace collapsed to a single space. Letter case is preserved. "  The   Quiet  River " becomes "The Quiet River". A title that is empty after trimming fails with `InvalidTitleError`, message `Title must not be empty`.

**R4. (Core) Author name parsing.** There are two input classes.
- Class A: a string containing exactly one comma, in the form "Last, First". It yields last name "Last" and first name "First", with whitespace around each part trimmed. "Okafor,  Ada " yields last "Okafor" and first "Ada".
- Class B: a string with no comma. It is treated as a single-name author: last name is the whole trimmed string and first name is the empty string. "Voss" yields last "Voss" and first "".

**R5. (Core) Malformed author rejection.** An author string with two or more commas, or with an empty last name (for example ", Ada"), fails with `InvalidAuthorError`. The message is `Malformed author name: ` followed by the original input.

## Search

**R6. (Search) Exact ISBN lookup.** Looking up an ISBN returns the single matching record, or no result if none matches. The query is normalized as in R1 before comparison, so "978-0-306-40615-7" finds the record stored under "9780306406157". A query that is not a valid ISBN-13 fails with Core's `InvalidIsbnError`; it does not return "no result".

**R7. (Search) Title prefix search.** A prefix query matches records whose normalized title starts with the normalized query, ignoring letter case. The query "the qu" matches "The Quiet River". It does not match "Into the Quiet", because the match is only at the start of the title. An empty or whitespace-only query returns an empty list, not every record.

**R8. (Search) Result ordering.** Results are sorted by title, compared ignoring case, in ascending order. Records with equal titles are then sorted by publication year, ascending. Records that still tie keep the order in which they were indexed. Given "Atlas" (2010), "atlas" (1999) and "Basin" (1985), the result order is "atlas" (1999), "Atlas" (2010), "Basin" (1985).

**R9. (Search) Duplicate indexing.** Indexing a record whose ISBN is already indexed replaces the earlier record. The index never holds two records with the same normalized ISBN, so a later prefix search returns the replacing record once.

## Report

**R10. (Report) Counts per decade.** The summary groups records by publication year into decades, where the decade is the year divided by 10, rounded down, then multiplied by 10. The output lists each decade that has at least one record, in ascending order, with its count. Years 1999 and 2000 fall into the 1990s and the 2000s respectively. Decades with no records are omitted. An empty record set yields an empty summary.

**R11. (Report) Citation line.** The citation for a record is `Last, F. (Year). Title. ISBN` for an author with a first name, where F is the first letter of the first name, uppercased. Example: `Okafor, A. (2004). The Quiet River. 9780306406157`. For a single-name author (R4 class B) the initial and its preceding comma and space are omitted: `Voss (2004). Atlas. 9780306406157`. With several authors, only the first author appears, followed by ", et al." directly after that author's name part, before the year: `Okafor, A., et al. (2004). The Quiet River. 9780306406157`.

**R12. (Report) Citation for unknown record.** Requesting a citation for an ISBN that Search does not find fails with `RecordNotFoundError`. The message is `No record for ISBN ` followed by the normalized 13-digit ISBN. An invalid ISBN fails earlier with Core's `InvalidIsbnError`, as in R6.
