// Why a walk of the history sidebar stops short. Counts and geometry ONLY —
// no thread ids, no titles, nothing from any conversation.
//
//   docker compose run --rm recon node scripts/cdp-eval.mjs --match=google \
//     --auth=ai:ai --file=scripts/probe-walk.js
//
// The existing probe-paginate.js answers "does scrolling load more" and prints
// titles to prove which threads it saw. This one answers a narrower question —
// WHERE does the walk stall — and prints nothing that came out of a chat.
//
// MUTATES: scrolls div.cIl10d. No clicks, no navigation.
//
// Its stop rule matches the app's walkSidebarThreads exactly, INCLUDING the
// `grew` guard, so a stall reproduced here is a stall in the app. The version
// in probe-paginate.js lacks that guard, which is the same divergence that put
// the wrong verdict on 358 entries.
(async () => {
  const scroller = document.querySelector('div.cIl10d');
  if (!scroller) return { error: 'div.cIl10d not found' };
  if (getComputedStyle(scroller).display === 'none') {
    return { error: 'sidebar closed — the DOM copy is stale' };
  }
  const rows = () => document.querySelectorAll('button.qqMZif[data-thread-id]');
  const seen = new Set();
  const absorb = () => {
    for (const el of rows()) {
      const id = el.getAttribute('data-thread-id');
      if (id) seen.add(id);
    }
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  scroller.scrollTop = 0;
  await wait(700);
  absorb();

  const clientH = scroller.clientHeight;
  const step = Math.min(clientH * 0.8, 320);
  const first = rows()[0]?.closest('li');
  const pitch = first ? Math.round(first.getBoundingClientRect().height) : 0;
  const expected = pitch ? Math.round(scroller.scrollHeight / pitch) : 0;

  const trail = [];
  let stagnant = 0;
  let lastH = scroller.scrollHeight;
  let stoppedBy = 'the step ceiling';
  for (let i = 1; i <= 200; i += 1) {
    const before = seen.size;
    const prevTop = scroller.scrollTop;
    scroller.scrollTop = Math.min(scroller.scrollTop + step, scroller.scrollHeight);
    await wait(700);
    absorb();
    const movedBy = Math.round(scroller.scrollTop - prevTop);
    const grew = scroller.scrollHeight > lastH;
    lastH = Math.max(lastH, scroller.scrollHeight);
    const atBottom = scroller.scrollTop + clientH >= scroller.scrollHeight - 8;
    // Every step, so the trail shows the exact step the growth stopped at
    // rather than only the total. A stall is a shape over steps, not a number.
    trail.push(
      `${i}: top=${Math.round(scroller.scrollTop)} moved=${movedBy} h=${scroller.scrollHeight}` +
        `${grew ? '+' : ' '} rendered=${rows().length} unique=${seen.size}` +
        `${seen.size > before ? ` (+${seen.size - before})` : ''}${atBottom ? ' BOTTOM' : ''}`,
    );
    if (atBottom && seen.size === before && !grew) {
      stagnant += 1;
      if (stagnant >= 3) {
        stoppedBy = 'the bottom';
        break;
      }
    } else {
      stagnant = 0;
    }
  }
  await wait(700);
  absorb();

  return {
    unique: seen.size,
    expected,
    stoppedBy,
    geometry: `clientH=${clientH} step=${Math.round(step)} pitch=${pitch} scrollH=${scroller.scrollHeight}`,
    // Trimmed to the shape: the first steps, and the last ones where it died.
    head: trail.slice(0, 6),
    tail: trail.slice(-10),
    steps: trail.length,
  };
})();
