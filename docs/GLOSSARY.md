# Glossary

The words this app uses, what they mean, and where the numbers come from. Every
count here was measured against a real archive on 2026-08-27 and is quoted to
show the scale a term operates at, not as a fixed property.

## Entry

**A unified umbrella: the linking point for an exchange's conversations.**

One row in the second column, with an id like `#1852`. It is what you name, file
into a folder, pick in a multi-select and open. It is the identity the archive
keeps for one real exchange.

An entry holds **no content of its own**. Everything — the turns, the images, the
date, the link — belongs to a conversation linked to it. The entry exists so that
several accounts of the same exchange have somewhere to meet.

### An entry has an origin, and its conversations have sources

Two different provenance facts, easily confused:

- the **source** of a conversation: where that account came from
- the **origin** of the entry: which source first caused the identity to exist

An entry can arrive from any of them, and `external_id` records which:

| origin | `external_id` | how the entry came to exist |
|---|---|---|
| threads | `<google id>` | seen in Google's list |
| takeout | `takeout:...` | an export described a conversation no entry existed for |
| a conversation | `entry:<n>` | an orphaned conversation was adopted, creating an umbrella for it |

So an entry that arrived from takeout may later gain a `threads` conversation, and
one that arrived from threads may later gain a `takeout` one. Neither changes the
origin: that records how the identity started, not what it now holds.

## Conversation

**The actual prompt-and-answer content.** What was asked, what came back, the
images, and the date it happened.

A conversation comes from a source, and the same real exchange can be known from
more than one:

Every way of getting content produces a conversation. They differ in the source,
and in what that source is good for — see "Which one to believe" below:

| from | action | what that conversation carries |
|---|---|---|
| **threads** — Google's live page | `Re-read from threads` | fuller text, the original images, source chips. Only works while Google still lists it. |
| **a link** — the export's saved URL | `Re-read from link` | second-precision date, inline anchors, and at least one link the live page has since dropped |
| **myactivity** | not built yet | the same activity live, loosely matching the export's |

So an entry with 13 turns from the export and 4 from a capture is not a
contradiction. It is two accounts of one exchange, of different lengths, and the
reader labels which one is on screen.

What you capture from a thread is a conversation; what you pull through a link is
also a conversation. Same kind of thing, different provenance — and provenance is
the only thing worth naming, so the buttons name it and nothing else.

This is why nothing is discarded when a second account arrives: neither contains
the other.

## Source

Where a conversation came from. Three today, and the list is open:

| source | the conversation is | reached by |
|---|---|---|
| **takeout** | what the export FILE recorded — parsed from `MyActivity.html` | importing an export |
| **link** | what the page shows when its saved URL is opened | `Read from links` |
| **threads** | what Google's live page shows now | `Read from threads` |

`takeout` and `link` are not the same source even though the link comes from the
export: one is the file's own account, the other is what Google serves today when
that address is opened, and they can disagree. Where they do, both are kept.

Future sources will sit alongside these rather than replacing them —
`myactivity` first, which holds the same activity live and should loosely match
the export's. It may well produce different results, which is the reason for
keeping them apart rather than merging them into one "imported" bucket.

The database stores `capture` where this table says `threads`. The word is
translated at the point of display: 1943 rows carry the stored string and several
queries match on it, so a rename there is a migration rather than an edit, and one
that gains nothing the translation does not.

## What a conversation records — and the gap

Each conversation should carry its own provenance: which source it came from, and
the link it came from, so where it came from is never a guess.

Half of that is true today. Measured 2026-08-27:

| | stored as | has a source | has a link | has its own id |
|---|---|---|---|---|
| from a **link** (export) | a row in `source_entries` | yes, `kind` | yes, `href` — 2026 of 3085 | yes, `e#1674` |
| from **threads** (capture) | the entry's turns in `messages` | only as a word in the entry's `sources` string | **no** | **no** |

`source_entries` holds 3085 conversations and every one of them is
`kind = 'takeout'`. 1943 entries hold turns that came from a capture, and **0**
of them have a conversation row recording that capture.

So a capture is a conversation in every sense except how it is stored — which
means that of the three sources, two produce rows that can coexist and the third
cannot. The accumulation described above works for `takeout` and `link` and stops
short for `threads`.

Put against the definition of an entry, it is plainer still: **an entry is meant
to hold no content of its own, and it holds the capture's turns.** The umbrella is
carrying one of the things it is supposed to be linking. That single fact is where
each of the following comes from:

- no date for when it was read, so a stale capture is indistinguishable from a
  fresh one
- no link, so which thread it was read from is only inferable from the entry
- no id, so the reader can offer "as imported · N turns" but cannot name it the
  way it names `e#1674`
- only one per entry, so a capture taken before a follow-up and one taken after
  cannot both be kept — the second replaces the first

Making captures rows in the same table as export conversations is what closes
this, and it is a schema change rather than a rename. Written down first because
the vocabulary now says these are the same kind of thing, and the storage does
not agree.

## Thread

**Google's word, for what Google still holds: the ~300 latest entries.**

AI Mode says "New thread" and "Search threads", and its history sidebar lists
about three hundred. Everything older has been rotated out of it and survives only
through a link.

A thread is **both** things at once, and an earlier version of this file got that
wrong by calling it only an entry Google can still show you. It is:

- **an entry** — the identity the archive keeps, created the first time the thread
  is seen in the list
- **a source** — and reading it produces one conversation, the `threads` one

## How one exchange accumulates

The same real exchange arrives from up to three directions, and each arrival adds
a conversation to the same entry rather than replacing what is there:

```
read the threads list        -> entry #1852 exists
read it from threads         -> conversation: source threads
import an export later       -> conversation: source takeout
open that export's link      -> conversation: source link
(myactivity, later)          -> conversation: source myactivity
```

One entry, several conversations, one per source. None of them is authoritative:
the `threads` one has the fuller text and the original images, the `takeout` one
has a second-precision date and links the live page has since dropped, and the
`link` one is what Google serves for that address today, which may differ from
what the export recorded when it was made.

This is the whole reason the model is many-to-many, and the reason nothing is
discarded when a later account arrives.

An entry records which thread it came from:

- `<google id>` — still listed, so it can be read from threads
- `takeout:...` — known only from an export; Google does not list it
- `entry:<n>` — created from a conversation that belonged to no entry yet

## A note on the names in the code and the UI

The database predates this vocabulary and does not use it. The mapping:

| here | table | the UI currently says |
|---|---|---|
| entry | `chats` | "thread", `#1852` |
| conversation (export) | `source_entries` | "data entry", `e#1674` |
| conversation (capture) | `messages` | the thread's own turns |

The words in the app have not been changed to match yet. Written down first,
because a rename that goes half way is worse than either name.

## Link

The URL a conversation carries — a `?udm=50&mstk=...` address that reopens that
thread on Google.

**One link per conversation.** `source_entries.href` is a single column, so a
conversation cannot hold two. **An entry can hold several**, one per conversation
linked to it: measured, 1932 entries have one link and 47 have two distinct ones.

Links come from the Takeout export today, and will also come from parsing
`myactivity.google.com`, which holds the same activity live. Those should loosely
match the export's — which is the second reason an entry ends up with more than
one, and the model already allows it without changing anything.

A link is never followed casually. Opening one is checked against the export's own
account first, because a link that **re-runs** its prompt instead of opening the
archived thread would cost a real query and add a conversation to Google's live
history. Where the page's date or prompt disagrees, nothing is stored.

## Orphan

A conversation linked to no entry. Legitimate by design: whatever cannot be placed
goes here rather than being forced onto the wrong entry, so nothing is stored and
invisible at the same time.

Measured: **1059** of 3085. Some are genuinely unplaceable; some lost their link
when a re-import could not re-identify them, which the import now counts and
reports separately.

## Folder (group)

Where an entry is filed. Exactly one parent per entry. `Unfiled` and `Filed` are
the two halves of the archive; every tree row carries its count, and a folder can
carry a colour and an icon that then appear on each of its entries.

## The verbs

- **Harvest** — walk Google's sidebar and record which threads exist. Titles and
  ids only, no content: it creates entries, it does not fill them.
- **Capture / read** — open one thread in the panel and store the conversation it
  shows, by clicking its row in Google's sidebar.
- **Pull** — get the conversation through a link instead. The only route to the
  threads Google no longer lists, and most of this archive is those.
- **Glue / unglue** — link a conversation to an entry, or unlink it. Always by
  hand: two conversations with the same opening prompt may be one exchange
  recorded twice, the same question asked twice, or a clone Google made, and the
  prompt alone cannot tell those apart.
- **Merge / fold** — declare two entries the same exchange. Never deletes:
  `merged_into` is set and unmerging reverses it exactly.

Folding is offered automatically only where no judgement is needed:

- an **empty** entry into its content-bearing twin — the empty one holds nothing
- entries sharing an opening prompt **and a start instant** — two separate asks do
  not land on the same second

Entries sharing only the prompt are left alone. Measured: 670 groups agreed on the
instant and were foldable; **68 did not and stay manual**.

## Two things worth knowing about the data

**Dates are inferred, and written three ways.** A thread's date comes from
matching export text, not from an id, so the UI marks it `~`. The same moment
appears as `...+07:00`, as `...Z`, or with no zone at all — 2024, 830 and 18
threads respectively — so dates are compared as instants, never as text.

**A placeholder date** is not the conversation's date. It is when the app first
stored the thread, kept so a thread is not undateable forever, shown faintly as
`saved <date>`, and overwritten the moment a real date arrives.
