// ===== Configuration =====
const SHEET_ID = '1SXCffLjPqWhMqZpEWICJ5F0EewAXHR2xEvG34cjXpAY';
const GOAL = 250;               // rental cost per week
const RENTAL_DAY = 3;           // 0 = Sun ... 3 = Wed
const REFRESH_MS = 60 * 1000;
const RECENT_COUNT = 10;
// No "order by" here: rows come back in sheet order (oldest added first),
// which newestFirst() uses to break ties between same-day donations.
const RECENT_QUERY =
  "select A, D where C = 'Received' and (B = 'Venmo' or B = 'Zelle' or B = 'Cash')";

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const $ = id => document.getElementById(id);
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
// Whole dollars; "+ 0" turns -0 into 0 so small negatives don't show as "-$0"
const money = { format: n => usd.format(Math.round(n) + 0) };
const cents = n => Math.round(n * 100) / 100; // strips float drift like -40.80000000000015

// ===== Google Sheets (gviz) helpers =====
function gvizUrl(params) {
  const q = new URLSearchParams({ tqx: 'out:json', ...params, _: Date.now() });
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${q}`;
}

async function gviz(params) {
  const res = await fetch(gvizUrl(params), { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const txt = await res.text();
  const json = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  if (json.status === 'error') throw new Error(json.errors?.[0]?.detailed_message || 'Query error');
  return json.table.rows.map(r => r.c.map(c => (c ? c.v : null)));
}

// "Date(2026,10,5,19,30,0)" -> Date (month is 0-based)
function parseGvizDate(v) {
  const m = /^Date\(([\d,]+)\)$/.exec(v || '');
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0, s = 0] = m[1].split(',').map(Number);
  return new Date(y, mo, d, h, mi, s);
}

// Newest date first; within the same date/time, the row added to the
// sheet later (lower down) comes first. Venmo rows are often date-only,
// so this keeps a single day's donations newest-on-top.
function newestFirst(rows) {
  return rows
    .map((r, i) => ({ r, i, t: parseGvizDate(r[0])?.getTime() ?? -Infinity }))
    .sort((a, b) => b.t - a.t || b.i - a.i)
    .slice(0, RECENT_COUNT)
    .map(x => x.r);
}

// ===== Formatting =====
function firstName(full) {
  const w = String(full || '').trim().split(/\s+/)[0] || '';
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

function shortDate(d, timeZone) {
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone }) : '';
}

// Only touch the DOM when text actually changes, so screen readers
// (aria-live) don't re-announce identical values every refresh.
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// ===== Rendering =====
function render(balance) {
  const pct = Math.max(0, Math.min(1, balance / GOAL));
  const amt = $('balance');
  setText(amt, money.format(balance));
  amt.classList.toggle('positive', balance >= 0);

  document.documentElement.style.setProperty('--p', pct);
  const track = $('track');
  track.classList.toggle('behind', balance < 0); // marker sits left of the start tick
  track.setAttribute('aria-valuemax', GOAL);
  track.setAttribute('aria-valuenow', Math.max(0, Math.min(GOAL, balance)));
  track.setAttribute('aria-valuetext', `${money.format(balance)} of ${money.format(GOAL)}`);

  const cap = $('caption');
  const needed = money.format(GOAL - Math.round(balance)); // matches the rounded total shown
  const key = pct >= 1 ? 'paid' : `need:${needed}`;
  if (cap.dataset.key === key) return;
  cap.dataset.key = key;
  cap.replaceChildren();
  if (pct >= 1) {
    cap.textContent = `The next field rental will be covered. See you ${DAY_NAMES[RENTAL_DAY]}.`;
  } else {
    const strong = document.createElement('strong');
    strong.textContent = needed;
    cap.append(strong, ' needed to cover the next field rental');
  }
}

function renderRecent(rows) {
  const ul = $('recent');
  const key = JSON.stringify(rows);
  if (ul.dataset.key === key) return;
  ul.dataset.key = key;
  ul.replaceChildren();
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No donations yet. Be the first to donate above.';
    ul.append(li);
    return;
  }
  rows.forEach(([date, who]) => {
    const li = document.createElement('li');
    const d = document.createElement('span');
    d.className = 'date';
    d.textContent = shortDate(parseGvizDate(date));
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = firstName(who);
    li.append(d, n);
    ul.append(li);
  });
}

// ===== Main loop =====
let refreshing = false;

async function refresh() {
  if (refreshing || document.hidden) return; // no overlap, no background polling
  refreshing = true;
  try {
    // Fetched independently so one failing doesn't hide the other
    const [bal, recent] = await Promise.allSettled([
      gviz({ sheet: 'Summary', range: 'B4', headers: '0' }),
      gviz({ sheet: 'Transactions', headers: '1', tq: RECENT_QUERY }),
    ]);

    let ok = true;
    const raw = bal.status === 'fulfilled' ? bal.value?.[0]?.[0] : null;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      render(cents(raw));
    } else {
      ok = false;
      console.error('Balance unavailable', bal.reason ?? raw);
    }

    if (recent.status === 'fulfilled') {
      renderRecent(newestFirst(recent.value));
    } else {
      ok = false;
      console.error('Recent donations unavailable', recent.reason);
    }

    $('error').hidden = ok;
  } finally {
    refreshing = false;
  }
}

// ===== Zelle copy-to-clipboard =====
let hintTimer;
$('zelleBtn').addEventListener('click', async e => {
  const email = e.currentTarget.dataset.email;
  const hint = $('zelleHint');
  try {
    await navigator.clipboard.writeText(email);
    hint.textContent = 'Copied. Paste it into Zelle in your bank app.';
  } catch {
    hint.textContent = 'Send with Zelle to the email above.';
  }
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { hint.textContent = ''; }, 3000);
});

refresh();
setInterval(refresh, REFRESH_MS);
document.addEventListener('visibilitychange', refresh); // refresh() ignores hidden state
