// ===== Configuration =====
const SHEET_ID = '1SXCffLjPqWhMqZpEWICJ5F0EewAXHR2xEvG34cjXpAY';
const GOAL = 250;               // rental cost per week
const RENTAL_DAY = 3;           // 0 = Sun ... 3 = Wed
const RENTAL_HOUR = 19, RENTAL_MIN = 30; // matches the Apps Script deduction time
const RENTAL_TZ = 'America/Los_Angeles'; // Apps Script time zone
const REFRESH_MS = 60 * 1000;
const RECENT_QUERY =
  "select A, D where C = 'Received' and (B = 'Venmo' or B = 'Zelle' or B = 'Cash') " +
  'order by A desc limit 7';

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

// ===== Formatting =====
function firstName(full) {
  const w = String(full || '').trim().split(/\s+/)[0] || '';
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

function shortDate(d, timeZone) {
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone }) : '';
}

// Next rental date label (e.g. "Nov 11"), computed on Pacific time so every
// viewer sees the date roll over when the Apps Script deduction does.
function nextRentalLabel(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: RENTAL_TZ, year: 'numeric', month: 'numeric', day: 'numeric',
      weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(now).map(p => [p.type, p.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  let add = (RENTAL_DAY - dow + 7) % 7;
  if (add === 0 && minutes >= RENTAL_HOUR * 60 + RENTAL_MIN) add = 7; // past tonight's rental
  const d = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + add));
  return shortDate(d, 'UTC');
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
  track.setAttribute('aria-valuemax', GOAL);
  track.setAttribute('aria-valuenow', Math.max(0, Math.min(GOAL, balance)));
  track.setAttribute('aria-valuetext', `${money.format(balance)} of ${money.format(GOAL)}`);

  const day = nextRentalLabel();
  const cap = $('caption');
  const needed = money.format(GOAL - Math.round(balance)); // matches the rounded total shown
  const key = pct >= 1 ? `paid:${day}` : `need:${needed}:${day}`;
  if (cap.dataset.key === key) return;
  cap.dataset.key = key;
  cap.replaceChildren();
  if (pct >= 1) {
    cap.textContent = `The ${day} field is paid for. See you ${DAY_NAMES[RENTAL_DAY]}.`;
  } else {
    const strong = document.createElement('strong');
    strong.textContent = needed;
    cap.append(strong, ` still needed for the ${day} field rental`);
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
    li.textContent = 'No donations yet. Be the first to donate below.';
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
  setText($('nextLabel'), `${nextRentalLabel()} Rental`);
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
      renderRecent(recent.value);
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
