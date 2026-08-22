// Recon for Google AI Mode's DOM. Paste this into the console of the embedded
// panel's DevTools (app menu: Debug -> Open AI Mode DevTools) while signed in
// and looking at your conversation history, then copy the JSON it prints.
//
// This deliberately assumes NO selectors. Every scraping selector this project
// will rely on has to come from a real page, and the whole harvester is
// blocked until that exists — guessing here just produces a driver that
// silently matches nothing.
//
// It reads only; it clicks nothing and sends nothing anywhere.
//
// Chromium blocks the first paste into DevTools for safety — if it refuses,
// type `allow pasting` at the console prompt once, then paste.
(() => {
  const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const brief = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    cls: typeof el.className === 'string' && el.className ? el.className.slice(0, 90) : undefined,
    aria: el.getAttribute('aria-label') || undefined,
    role: el.getAttribute('role') || undefined,
    title: el.getAttribute('title') || undefined,
    href: el.getAttribute('href') || undefined,
    text: text(el).slice(0, 70) || undefined,
  });
  const all = (sel) => Array.from(document.querySelectorAll(sel));

  const out = { url: location.href, inIframe: window !== window.top, childFrames: window.length };

  // Which frame are we in, and does the app's preload reach it? Determines
  // whether nodeIntegrationInSubFrames has to be turned on (PromptLoom needed
  // it for perchance).
  out.preloadPresent = typeof window.notebookBridge !== 'undefined';

  // Anything that looks like the control that opens history, so the harvester
  // knows what to click to enumerate threads.
  const historyRe = /history|conversation|thread|recent|past|chats/i;
  out.historyControls = all('button,[role="button"],a,[role="link"]')
    .filter((el) => historyRe.test([el.getAttribute('aria-label'), el.title, text(el).slice(0, 40)].join(' ')))
    .slice(0, 25)
    .map(brief);

  // Repeated data-* attributes are the most likely home of a stable thread id.
  // Reported as a histogram: an attribute appearing once is page furniture, one
  // appearing many times with distinct values is a list of things.
  const attrCounts = {};
  for (const el of all('*')) {
    for (const at of el.attributes) {
      if (!at.name.startsWith('data-')) continue;
      const rec = (attrCounts[at.name] ||= { count: 0, distinct: new Set(), sample: at.value.slice(0, 40) });
      rec.count += 1;
      if (rec.distinct.size < 60) rec.distinct.add(at.value.slice(0, 40));
    }
  }
  out.dataAttributes = Object.entries(attrCounts)
    .map(([name, r]) => ({ name, count: r.count, distinct: r.distinct.size, sample: r.sample }))
    // count >= 2 rather than > 2: a partially-rendered or short history
    // list can hold only two threads, and that is precisely when the
    // thread-id attribute matters most. Tested against a two-thread
    // fixture, where the stricter threshold reported nothing at all.
    .filter((r) => r.count >= 2 && r.distinct > 1)
    .sort((a, b) => b.distinct - a.distinct)
    .slice(0, 25);

  // Links that look like they address a specific conversation — this is what
  // decides whether Resume can just navigate to a URL, or has to click through
  // the history panel instead.
  out.conversationLinks = all('a[href]')
    .map((el) => el.getAttribute('href'))
    .filter((h) => h && /udm=50|aimode|[?&](sca_|mtid|cid|tid|thread)/i.test(h))
    .filter((h, i, a) => a.indexOf(h) === i)
    .slice(0, 20);

  // Blocks of real prose, to locate the turn containers. Deepest elements
  // holding a lot of text, with their ancestor chain — the repeating ancestor
  // is usually the per-turn wrapper.
  out.textBlocks = all('div,section,article,p,li')
    // 100 rather than 180 chars: a typed question is often much shorter
    // than the answer, and catching both is what reveals whether user and
    // AI turns share a wrapper or use different ones.
    .filter((el) => text(el).length > 100 && el.children.length < 25)
    .filter((el) => !Array.from(el.children).some((c) => text(c).length > 100))
    .slice(0, 8)
    .map((el) => ({
      self: brief(el),
      chars: text(el).length,
      ancestors: (() => {
        const chain = [];
        let p = el.parentElement;
        for (let i = 0; i < 4 && p; i += 1, p = p.parentElement) chain.push(brief(p));
        return chain;
      })(),
    }));

  // Image hosts and a sample URL each — determines how the asset pipeline has
  // to fetch them (cookies? data URIs? lazy-loaded placeholders?).
  const hosts = {};
  for (const img of all('img')) {
    const src = img.currentSrc || img.src || '';
    if (!src) continue;
    let host = 'other';
    try {
      host = src.startsWith('data:') ? 'data:' : new URL(src, location.href).host;
    } catch {
      /* leave as other */
    }
    const rec = (hosts[host] ||= { count: 0, sample: src.slice(0, 140), lazyAttrs: new Set() });
    rec.count += 1;
    for (const at of img.attributes) {
      if (/^(data-src|data-lazy|loading|srcset|data-deferred)/i.test(at.name)) rec.lazyAttrs.add(at.name);
    }
  }
  out.imageHosts = Object.entries(hosts).map(([host, r]) => ({
    host,
    count: r.count,
    lazyAttrs: [...r.lazyAttrs],
    sample: r.sample,
  }));

  const json = JSON.stringify(out, null, 2);
  console.log(json);
  try {
    copy(out); // DevTools helper: puts it on the clipboard
    console.log('%cCopied to clipboard — paste it back.', 'color:#0a0;font-weight:bold');
  } catch {
    console.log('Select the JSON above and copy it manually.');
  }
  return out;
})();
