// Answers whether scrolling the AI Mode history list loads more threads, and
// what the end-of-list signal is. This is the last unknown blocking the
// harvester, and it becomes the harvester's scroll loop.
//
//   docker compose run --rm recon node scripts/cdp-eval.mjs --file=scripts/probe-paginate.js
//
// UNLIKE the other probes this MUTATES the page: it scrolls div.cIl10d to the
// bottom in steps. Nothing else — no clicks, no navigation — and the sidebar
// can be scrolled back by hand afterwards.
//
// Accumulates a union of thread ids across steps rather than counting what is
// rendered. The list is virtualised, so rows appear AND disappear as it moves;
// counting the DOM at any instant undercounts badly (10, 20 and 60 were all
// observed on the same list).
(async () => {
  const scroller = document.querySelector('div.cIl10d');
  if (!scroller) return { error: 'div.cIl10d not found' };
  if (getComputedStyle(scroller).display === 'none') {
    return { error: 'History sidebar is closed — open it first, the DOM copy is stale' };
  }

  const seen = new Map();
  const harvest = () => {
    for (const el of document.querySelectorAll('button.qqMZif[data-thread-id]')) {
      const id = el.getAttribute('data-thread-id');
      if (!id || seen.has(id)) continue;
      const row = el.closest('li');
      const overflow = row ? row.querySelector('button.fMed7[aria-label]') : null;
      const label = overflow ? overflow.getAttribute('aria-label') || '' : '';
      seen.set(
        id,
        label.replace(/^more options for\s*/i, '').trim() ||
          (el.textContent || '').replace(/\s+/g, ' ').trim(),
      );
    }
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const startScrollTop = scroller.scrollTop;
  const steps = [];
  harvest();
  steps.push({ step: 0, top: Math.round(scroller.scrollTop), scrollH: scroller.scrollHeight, rendered: document.querySelectorAll('button.qqMZif[data-thread-id]').length, unique: seen.size });

  let stagnant = 0;
  for (let i = 1; i <= 45; i += 1) {
    const before = seen.size;
    const prevH = scroller.scrollHeight;
    scroller.scrollTop = Math.min(scroller.scrollTop + scroller.clientHeight * 0.8, scroller.scrollHeight);
    await wait(700);
    harvest();
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
    steps.push({
      step: i,
      top: Math.round(scroller.scrollTop),
      scrollH: scroller.scrollHeight,
      grewH: scroller.scrollHeight - prevH,
      rendered: document.querySelectorAll('button.qqMZif[data-thread-id]').length,
      unique: seen.size,
      newThisStep: seen.size - before,
      atBottom,
    });
    // Stop only after the bottom stays reached AND nothing new arrives, so a
    // list that extends itself on reaching the end is not cut short.
    if (atBottom && seen.size === before) {
      stagnant += 1;
      if (stagnant >= 3) break;
    } else {
      stagnant = 0;
    }
  }

  const ids = [...seen.entries()];
  return {
    startScrollTop,
    finalScrollH: scroller.scrollHeight,
    clientH: scroller.clientHeight,
    uniqueThreads: seen.size,
    firstFive: ids.slice(0, 5).map(([id, t]) => `${id} :: ${t.slice(0, 40)}`),
    lastFive: ids.slice(-5).map(([id, t]) => `${id} :: ${t.slice(0, 40)}`),
    steps,
  };
})();
