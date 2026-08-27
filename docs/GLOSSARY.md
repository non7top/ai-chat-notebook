# Glossary

The words this app uses, what they mean, and where the numbers come from. Every
count here was measured against a real archive on 2026-08-27 and is quoted to
show the scale a term operates at, not as a fixed property.

## Thread

Google's own word, and the reason this app uses it: AI Mode says "New thread"
and "Search threads". One conversation — a prompt, an answer, and any follow-ups.

The **panel** is Google's live UI, and its history sidebar holds roughly the last
**300** threads. That is the whole of what Google will show; everything older has
been rotated out of the sidebar and is reachable only through an export.

In the app a thread is one row in the list and has an id like `#2842`. Its
identity is `external_id`:

- `<google id>` — seen in the sidebar, so the panel can open it
- `takeout:...` — known only from an export; Google no longer lists it
- `entry:<n>` — created by adopting a record that belonged to no thread

## Entry (record)

One raw row from a source, stored verbatim and never rewritten. Ids look like
`e#1674` — deliberately unlike a thread's `#1674`, because they are different
things and a bug report needs to name one exactly.

An entry is **an observation of a thread**, not the thread itself. A thread can
have several: one export record per submission, so a conversation snapshotted
three times as it grew is three entries. Measured: 1932 threads hold one entry,
47 hold two.

**An entry does hold a conversation** — its own copy of the turns, images, date
and link, as that source recorded them. So "a captured conversation" is close,
and the difference is worth keeping because the app uses `capture` for something
else:

|  | written by | stored in | shown as |
|---|---|---|---|
| **capture** | the app, reading Google's live panel | the thread's turns | `Re-read: panel` |
| **entry** | a source — the Takeout export — describing what it saw | the entry's own payload | `Re-read: export link`, `e#1674` |

Both are readings of the same conversation. A capture is the app's own; an entry
is somebody else's, kept verbatim. That is why the reader can show you either and
why it labels which one you are looking at — and why a thread with 13 turns from
an entry and 4 from a capture is not a contradiction, just two accounts of
different lengths.

Entries are kept whole so a parser fix can be applied by re-reading them rather
than by asking Google again.

## Link

The URL an entry carries — a `?udm=50&mstk=...` address that reopens that thread
on Google.

**One link per entry.** `source_entries.href` is a single column, so an entry
cannot hold two. **A thread can hold several**, one per entry: measured, 47
threads currently have two distinct links.

Links come from the Takeout export today. They can also come from parsing
`myactivity.google.com` directly, which holds the same activity live — those
should loosely match the export's, and where they differ the later source is the
current one. That is a second reason a thread may end up with more than one link,
and the entry model already allows it without changing anything.

A link is never followed casually. Opening one goes through a check against the
export's own reading first, because a link that **re-runs** its prompt instead of
opening the archived thread would cost a real query and add a conversation to the
live history. Where the page's date or prompt disagrees with the record, nothing
is stored.

## Reading

What one source says a thread contains. Two exist and neither contains the other:

| | has |
|---|---|
| **panel** | fuller text, the original images, source chips |
| **export** | second-precision dates, inline anchors, and at least one link the live page has since dropped |

So "re-read" always names its source — `Re-read: panel` or `Re-read: export
link` — because which one you get is the only difference between them.

## Orphan

An entry attached to no thread. Legitimate by design: whatever cannot be placed
goes here rather than being forced somewhere wrong, so that nothing is stored and
invisible at the same time.

Measured: **1059** of 3085 records. Some are unplaceable; some lost their link
when a re-import could not re-identify them, which the import now counts and
reports separately.

## Folder (group)

Where a thread is filed. Exactly one parent per thread. `Unfiled` and `Filed` are
the two halves of the archive; every tree row carries its count, and a folder can
carry a colour and an icon that then appear on each of its threads.

## The verbs

- **Harvest** — walk Google's sidebar and record which threads exist. Titles and
  ids only, no content.
- **Capture / read** — open one thread and store its turns. From the panel, by
  clicking its sidebar row.
- **Pull** — read a thread through an entry's link instead. The only route to the
  threads Google no longer lists, and most of the archive is those.
- **Glue / unglue** — attach an entry to a thread, or detach it. Always by hand:
  two records with the same opening prompt may be one conversation twice, the
  same question asked twice, or a clone Google made, and nothing can tell those
  apart from the prompt alone.
- **Merge / fold** — declare two threads the same conversation. Never deletes:
  `merged_into` is set and unmerging reverses it exactly.

Folding is offered automatically only where no judgement is needed:

- an **empty** thread into its content-bearing twin — the empty one holds nothing
- threads sharing an opening prompt **and a start instant** — two separate asks
  do not land on the same second

Groups sharing only the prompt are left alone. Measured: 670 groups agreed on the
instant and were foldable; **68 did not and stay manual**.

## Two things worth knowing about the data

**Dates are inferred, and written three ways.** A thread's date comes from
matching export text, not from an id, so the UI marks it `~`. The same moment
appears as `...+07:00`, as `...Z`, or with no zone at all — 2024, 830 and 18
threads respectively — so dates are compared as instants, never as text.

**A placeholder date** is not the conversation's date. It is when the app first
stored the thread, kept so a thread is not undateable forever, shown faintly as
`saved <date>`, and overwritten the moment a real date arrives.
