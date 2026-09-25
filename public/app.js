/* OffAir UI — vanilla JS, no build step. Talks only to the local server. */
const $ = (sel) => document.querySelector(sel);

const state = {
  interviews: [],
  current: null, // full record of the open interview
  currentSummary: null,
};

/* ---------- helpers ---------- */
const fmtTime = (ms) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function showJob(boxId, show) {
  const box = $(boxId);
  box.hidden = !show;
  if (show) {
    box.querySelector('.bar').classList.add('indeterminate');
    box.querySelector('.bar i').style.width = '';
    box.querySelector('.job-msg').textContent = 'Working…';
  }
}
function jobMsg(boxId, msg, pct) {
  const box = $(boxId);
  box.hidden = false;
  box.querySelector('.job-msg').textContent = msg;
  const bar = box.querySelector('.bar');
  if (typeof pct === 'number' && pct >= 0) {
    bar.classList.remove('indeterminate');
    bar.querySelector('i').style.width = `${Math.min(100, pct)}%`;
  } else {
    bar.classList.add('indeterminate');
  }
}
function hideJob(boxId) {
  $(boxId).hidden = true;
}

/* Follow one job's SSE stream until done/error. */
function watchJob(jobId, boxId, handlers = {}) {
  return new Promise((resolve, reject) => {
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    es.onmessage = (e) => {
      const evt = JSON.parse(e.data);
      if (evt.phase === 'status' || evt.phase === 'download') {
        jobMsg(boxId, evt.message ?? `Downloading ${evt.label ?? ''} ${Math.round(evt.percentage ?? 0)}%`, evt.phase === 'download' ? evt.percentage : undefined);
        handlers.onStatus?.(evt);
      } else if (evt.phase === 'interview') {
        handlers.onInterview?.(evt.id);
      } else if (evt.phase === 'search') {
        handlers.onSearch?.(evt.result);
      } else if (evt.phase === 'done') {
        es.close();
        hideJob(boxId);
        resolve();
      } else if (evt.phase === 'error') {
        es.close();
        hideJob(boxId);
        jobMsg(boxId, `Error: ${evt.message ?? 'unknown'}`, -1);
        setTimeout(() => hideJob(boxId), 8000);
        reject(new Error(evt.message ?? 'job failed'));
      }
    };
    es.onerror = () => {
      es.close();
      reject(new Error('Connection to local server lost'));
    };
  });
}

/* ---------- status / model chips ---------- */
async function loadStatus() {
  try {
    const st = await fetch('/api/status').then((r) => r.json());
    $('#modelChips').innerHTML = Object.entries(st.models)
      .map(([k, m]) => `<span class="mchip ${m.loaded ? 'loaded' : ''}">${esc(m.label)}${m.loaded ? ' ✓' : ''}</span>`)
      .join('');
  } catch {
    $('#modelChips').innerHTML = '<span class="mchip">server offline</span>';
  }
}

/* ---------- interview list ---------- */
async function loadList() {
  state.interviews = await fetch('/api/interviews').then((r) => r.json());
  const nav = $('#interviewList');
  if (!state.interviews.length) {
    nav.innerHTML = '<div class="empty-msg">No interviews yet — your desk is clean.</div>';
    return;
  }
  nav.innerHTML = state.interviews
    .map(
      (r) => `
      <div class="item ${state.currentSummary?.id === r.id ? 'active' : ''}" data-id="${r.id}">
        <div class="nm">${esc(r.name)}</div>
        <div class="sub">${r.segmentCount} segments · ${r.findingCount} redactions${r.hasBrief ? ' · briefed' : ''}${r.ragIngested ? ' · indexed' : ''}</div>
      </div>`
    )
    .join('');
  nav.querySelectorAll('.item').forEach((el) =>
    el.addEventListener('click', () => openInterview(el.dataset.id))
  );
}

/* ---------- detail ---------- */
async function openInterview(id) {
  state.current = await fetch(`/api/interviews/${id}`).then((r) => r.json());
  state.currentSummary = state.interviews.find((r) => r.id === id) ?? null;
  $('#empty').hidden = true;
  $('#searchPanel').hidden = true;
  $('#detail').hidden = false;
  renderDetail();
  loadList();
}

function renderDetail() {
  const rec = state.current;
  if (!rec) return;
  $('#detailName').textContent = rec.name;
  const dur = rec.segments.length ? rec.segments[rec.segments.length - 1].endMs : 0;
  const active = (rec.findings ?? []).filter((f) => f.enabled !== false).length;
  $('#detailMeta').textContent = [
    new Date(rec.createdAt).toLocaleString(),
    `${rec.segments.length} segments`,
    dur ? fmtTime(dur) : null,
    `${active} active redactions`,
    rec.ragIngested ? 'indexed' : 'not indexed',
  ].filter(Boolean).join(' · ');
  $('#btnExport').href = `/api/interviews/${rec.id}/export`;
  $('#btnIngest').textContent = rec.ragIngested ? 'Re-index' : 'Add to search index';

  const countEl = $('#findingCount');
  countEl.hidden = active === 0;
  countEl.textContent = active;

  renderRaw();
  renderSafe();
  renderBrief();
}

function renderRaw() {
  $('#tab-raw').innerHTML = state.current.segments
    .map((s) => `<div class="seg"><div class="t">${fmtTime(s.startMs)}</div><div>${esc(s.text)}</div></div>`)
    .join('') || '<p class="empty-msg">Not transcribed yet.</p>';
}

function renderSafe() {
  const rec = state.current;
  const findings = rec.findings ?? [];
  const chips = findings
    .map(
      (f) => `
      <span class="chip ${f.enabled === false ? 'off' : ''}" data-text="${esc(f.text)}" data-enabled="${f.enabled !== false}"
            title="${esc(f.text)} — click to ${f.enabled === false ? 're-enable' : 'disable'} this redaction">
        <span class="dot"></span><span class="lbl">${esc(f.label ?? 'ITEM')}</span> ${esc(f.type)}
        <span class="src">(${esc(f.source ?? 'manual')})</span>
      </span>`
    )
    .join('');
  const segs = (rec.redacted ?? [])
    .map((s) => {
      const html = esc(s.text).replace(
        /\b((?:PERSON|ORG|PLACE|PHONE|ID|URL|EMAIL|HANDLE|MANUAL|ITEM)-\d+)\b/g,
        (m) => `<mark class="redacted">${m}</mark>`
      );
      return `<div class="seg"><div class="t">${fmtTime(s.startMs)}</div><div>${html}</div></div>`;
    })
    .join('');
  $('#tab-safe').innerHTML =
    (chips ? `<div class="findings">${chips}</div><p class="hint" style="margin-top:0">Click a chip to disable/enable that redaction. Every redaction ships only after you approve it.</p>` : '') +
    (segs || '<p class="empty-msg">Nothing to protect yet.</p>');

  $('#tab-safe')
    .querySelectorAll('.chip')
    .forEach((chip) =>
      chip.addEventListener('click', async () => {
        await fetch(`/api/interviews/${state.current.id}/findings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: chip.dataset.text, enabled: chip.dataset.enabled !== 'true' }),
        });
        await openInterview(state.current.id);
      })
    );
}

function renderBrief() {
  const b = state.current.brief;
  if (!b) {
    $('#tab-brief').innerHTML = '<p class="empty-msg">No brief yet — click “Generate brief”.</p>';
    return;
  }
  const quotes = (b.quotes ?? [])
    .map(
      (q) =>
        `<blockquote>${esc(q.text)}${q.startMs != null ? `<span class="ts">@ ${fmtTime(q.startMs)}</span>` : ''}</blockquote>`
    )
    .join('');
  $('#tab-brief').innerHTML = `
    <div class="brief">
      <h3>Summary</h3><p>${esc(b.summary)}</p>
      <h3>Key claims</h3><ul>${(b.claims ?? []).map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      <h3>Quotes</h3>${quotes || '<p class="empty-msg">none</p>'}
      <h3>Follow-ups</h3><ul>${(b.followups ?? []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
    </div>`;
}

/* ---------- tabs ---------- */
document.querySelectorAll('.tabs button').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
  })
);

/* ---------- add interview ---------- */
$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('#fileInput').files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('audio', file);
  fd.append('name', $('#nameInput').value.trim());
  fd.append('whisper', $('#whisperSelect').value);
  showJob('#addJob', true);
  try {
    const res = await fetch('/api/interviews', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).error ?? 'upload failed');
    const { id, jobId } = await res.json();
    await watchJob(jobId, '#addJob', { onInterview: (nid) => {} });
    await loadList();
    await openInterview(id);
    $('#addForm').reset();
  } catch (err) {
    jobMsg('#addJob', `Error: ${err.message}`, -1);
    setTimeout(() => hideJob('#addJob'), 8000);
  }
});

/* ---------- detail actions ---------- */
$('#btnLlmRedact')?.addEventListener('click', async () => {
  if (!state.current) return;
  showJob('#detailJob', true);
  try {
    const { jobId } = await fetch(`/api/interviews/${state.current.id}/llm-redact`, { method: 'POST' }).then((r) => r.json());
    await watchJob(jobId, '#detailJob', { onInterview: () => {} });
    await openInterview(state.current.id);
    document.querySelector('.tabs button[data-tab="safe"]').click();
  } catch { /* shown in job box */ }
});

$('#btnBrief')?.addEventListener('click', async () => {
  if (!state.current) return;
  showJob('#detailJob', true);
  try {
    const { jobId } = await fetch(`/api/interviews/${state.current.id}/brief`, { method: 'POST' }).then((r) => r.json());
    await watchJob(jobId, '#detailJob', { onInterview: () => {} });
    await openInterview(state.current.id);
    document.querySelector('.tabs button[data-tab="brief"]').click();
  } catch { /* shown in job box */ }
});

$('#btnIngest')?.addEventListener('click', async () => {
  showJob('#detailJob', true);
  try {
    const { jobId } = await fetch('/api/ingest', { method: 'POST' }).then((r) => r.json());
    await watchJob(jobId, '#detailJob');
    await loadList();
    if (state.current) await openInterview(state.current.id);
  } catch { /* shown in job box */ }
});

/* ---------- search ---------- */
$('#searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = $('#searchInput').value.trim();
  if (!query) return;
  $('#empty').hidden = true;
  $('#detail').hidden = true;
  $('#searchPanel').hidden = false;
  $('#searchAnswer').innerHTML = '';
  $('#searchHits').innerHTML = '';
  showJob('#searchJob', true);
  try {
    const { jobId } = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    }).then((r) => r.json());
    await watchJob(jobId, '#searchJob', {
      onSearch: (result) => {
        $('#searchAnswer').textContent = result.answer || '(no answer)';
        $('#searchHits').innerHTML = (result.hits ?? [])
          .map(
            (h) => `
            <div class="hit">
              <div class="score">match ${(h.score * 100).toFixed(1)}%</div>
              <div class="txt">${esc(h.content)}</div>
            </div>`
          )
          .join('');
      },
    });
  } catch (err) {
    $('#searchAnswer').textContent = `Error: ${err.message}`;
  }
});

$('#btnCloseSearch')?.addEventListener('click', () => {
  $('#searchPanel').hidden = true;
  if (state.currentSummary) openInterview(state.currentSummary.id);
  else $('#empty').hidden = false;
});

/* ---------- boot ---------- */
loadStatus();
loadList();
setInterval(loadStatus, 5000);
