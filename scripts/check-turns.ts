/**
 * Turn splitting against the export's real markup.
 *
 * An answer is not made of paragraphs. It contains code blocks, headings, lists,
 * tables and blockquotes as SIBLINGS of its paragraphs, and the splitter used to
 * walk querySelectorAll('p') — so none of those were ever visited. Measured
 * against one real export that was 3032 code blocks, 16990 headings, 51979 list
 * items, 608 tables and 805 blockquotes discarded without a trace. In an archive
 * of technical questions the code block is usually the answer.
 *
 * The fixtures below reproduce the shape read out of a real MyActivity.html:
 * a labelled paragraph, then sibling blocks, then the next label.
 *
 *   npm run check:turns
 */
import { JSDOM } from 'jsdom';
import { turnsFrom } from '../src/renderer/parseTakeout.ts';

let failures = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`, ok ? '' : `got ${JSON.stringify(got)}`);
}

// jsdom is a dev dependency for exactly this: the parser runs in the renderer
// against a real DOM, and the bugs in it have all been about which nodes get
// visited. Reasoning about that from the source is how they got shipped twice.
const cellOf = (inner: string): Element => {
  const dom = new JSDOM(`<body><div>${inner}</div></body>`);
  const cell = dom.window.document.body.firstElementChild;
  if (!cell) throw new Error('fixture produced no element');
  return cell as unknown as Element;
};

// The exact shape from the export: label, prose, heading, code, list with code
// nested in a list item.
const real = cellOf(`
<p><strong>Your prompt:</strong><br>
gpg clearsign specify the key</p>
<p><strong>Search's response:</strong><br>
To specify a key, use the <strong><code>-u</code></strong> option.</p>
<pre><code>gpg --local-user "KEY" --clearsign file.txt
</code></pre>
<h3>Key Identifier Formats</h3>
<ul>
<li><strong>Email address</strong>:
<pre><code>gpg -u "user@example.com" --clearsign file.txt
</code></pre>
</li>
</ul>
`);

const turns = turnsFrom(real);
check('two turns, not one per block', turns.length, 2);
check('roles in order', turns.map((t) => t.role), ['user', 'ai']);
check('the prompt keeps its text', turns[0].text.includes('gpg clearsign specify the key'), true);

const answer = turns[1];
check('the code block survives', answer.html.includes('<pre>'), true);
check('the heading survives', answer.html.includes('<h3>'), true);
check('the list survives', answer.html.includes('<li>'), true);
check('code nested in a list item survives', answer.html.split('<pre>').length - 1, 2);
check('the command text reaches the plain text too', answer.text.includes('--clearsign'), true);
// Emphasis inside an answer must not read as a new turn: <strong> is used freely
// for bold, and only a <strong> that OPENS a paragraph is a label.
check('bold mid-answer does not start a turn', answer.html.includes('<code>-u</code>'), true);

// A <strong> opening a paragraph that is not one of Google's labels is content,
// not a delimiter.
const notALabel = turnsFrom(
  cellOf(`<p><strong>Your prompt:</strong><br>q</p><p><strong>Note:</strong> a bold opener</p>`),
);
check('a non-label bold opener stays content', notALabel.length, 1);
check('and its text is kept', notALabel[0].text.includes('a bold opener'), true);

// Content before the first label is the record's own header, not a turn.
const withHeader = turnsFrom(
  cellOf(`Searched for <a href="https://x/?q=a">a</a><br>Aug 2, 2026<p><strong>Your prompt:</strong><br>q</p>`),
);
check('header text before the first label is not a turn', withHeader.length, 1);
check('and does not leak into the prompt', withHeader[0].text.includes('Searched for'), false);

if (failures > 0) throw new Error(`${failures} check(s) failed`);
console.log('OK');
