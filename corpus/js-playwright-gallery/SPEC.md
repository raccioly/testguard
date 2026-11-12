# Lantern Hall Community Photo Exhibit Page

A single page shows a grid of photo cards. Each card has a title, photographer, year and tags. Visitors can search, filter by tag, sort and mark favorites. Rendered output and the underlying functions must agree.

## Search and tag filtering

R1. Text search is a case-insensitive substring match on title and photographer, after trimming leading and trailing whitespace from the query. A query that is empty or whitespace-only matches every card. Example: the query "  harbor " matches a card titled "Old Harbor Light".

R2. Tag filtering has two input classes. With no tag buttons active, no tag filter applies. With one or more tags active, a card is kept only if it carries ALL active tags (AND semantics). Tag comparison is exact and case-sensitive. A tag button is active when its aria-pressed is "true" and inactive when it is "false". Search and tag filters combine with AND.

R3. The page shows the visible text "Showing N of M photos", where N is the number of cards that pass the filters and M is the total number of cards. When N is 0, the grid is replaced by the text "No photos match your filters." and the "Showing" line reads "Showing 0 of M photos".

## Sorting

R4. The sort control offers exactly two choices: "year" and "title". The default is "title". Sorting by title is ascending, case-insensitive, and ties are broken by year ascending. Sorting by year is descending (newest first), and ties are broken by title ascending, case-insensitive. Sorting never changes the set of cards, only their order.

R5. Sorting is applied after filtering, and the sort function must not mutate the input list. Given an empty list, it returns an empty list. An unrecognized sort key is rejected with an error named "InvalidSortKey" whose message is "Unknown sort key: <key>".

## Favorites

R6. Each card has a favorite toggle button whose aria-pressed is "false" initially. Activating it sets aria-pressed to "true", activating it again sets it back to "false". Toggling a card's favorite never changes the card order or the filter results.

R7. The page shows the visible text "Favorites: K", where K is the number of favorited cards across the whole exhibit, including cards currently hidden by filters. It starts at "Favorites: 0". The toggle function takes a set of favorited card ids and an id, returns a new set with that id added or removed, and does not mutate its input. An id that does not belong to any card is rejected with an error named "UnknownCardId" whose message is "Unknown card id: <id>".

## Data validation and rendering

R8. A card is valid only if its title and photographer are non-empty after trimming, its year is an integer from 1826 through 2026 inclusive, and its tags are an array of non-empty strings. An invalid card is rejected with an error named "InvalidCard" whose message is "Invalid card: <field>", where <field> is the first failing field in the order title, photographer, year, tags. Example: year 1825 yields "Invalid card: year".

R9. Tags are normalized when a card is loaded: each tag is trimmed and lowercased, and duplicates are removed while keeping first-occurrence order. A card with tags ["Portrait", " portrait", "Night"] renders the tags "portrait" and "night", in that order. The set of tag filter buttons is the union of all normalized tags, sorted alphabetically.

R10. Each card renders its title, then "by <photographer>", then the year as four digits, then its tags as separate elements. Each card carries a data-id attribute equal to its id. Card ids are unique, and two cards with the same id are rejected at load with an error named "DuplicateCardId" whose message is "Duplicate card id: <id>".
