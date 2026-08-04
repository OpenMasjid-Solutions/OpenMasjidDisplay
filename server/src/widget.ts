// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Public, embeddable web widget for one timetable — the OpenMasjid look in a card a
 * masjid drops onto their own website via an <iframe>. Two halves that sit side by side
 * on wide embeds and stack on narrow ones: a "today" card (masjid name, date, a live
 * "next prayer" countdown, and the day's Adhan/Iqamah table) and an interactive week
 * table (Prev / week picker / Next; click any day to load it into the card).
 *
 * Served unauthenticated (only for timetables whose `widget.enabled` is true) and fully
 * self-contained (inline CSS/JS). It fetches its own JSON — /w/<id>.json?date=&week= —
 * so the countdown stays live and the visitor can browse other days without a reload.
 */
import type { WidgetPayload } from './render/svg';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** The self-contained HTML page. `data` seeds the first paint; `jsonPath` is the
 *  (relative) URL the page fetches for other days/weeks and to keep the countdown live. */
export function renderWidgetHtml(data: WidgetPayload, jsonPath: string, logo?: string | null): string {
  return `<!doctype html>
<html lang="${esc(data.language)}"${data.rtl ? ' dir="rtl"' : ''}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(data.masjidName)} — Prayer times</title>
<style>
  :root {
    --bg:#f3f1e8; --card:#faf8f2; --ink:#22302a; --dim:#6d7d73; --faint:#93a099;
    --line:rgba(34,48,42,.12); --hover:rgba(34,48,42,.05);
    --primary:#158a5f; --primary-soft:rgba(21,138,95,.12); --gold:#b07d13;
    --radius:16px;
    --font:-apple-system,"Segoe UI",Roboto,"Noto Sans","Noto Naskh Arabic","Amiri",Arial,sans-serif;
  }
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; }
  body { font-family:var(--font); background:transparent; color:var(--ink); -webkit-font-smoothing:antialiased; }
  .omw { max-width:940px; margin:0 auto; padding:12px; display:grid; gap:12px; grid-template-columns:minmax(0,1fr); }
  @media (min-width:700px){ .omw { grid-template-columns:minmax(0,1fr) minmax(0,1.05fr); align-items:start; } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:var(--radius);
          box-shadow:0 10px 30px -18px rgba(0,0,0,.35); overflow:hidden; min-width:0; }
  .wk-scroll { overflow-x:auto; -webkit-overflow-scrolling:touch; }
  .pad { padding:16px; }
  /* Header */
  .head { display:flex; align-items:center; gap:12px; padding:16px; border-bottom:1px solid var(--line); }
  .mark { flex:0 0 auto; width:38px; height:38px; color:var(--primary); }
  img.mark { object-fit:contain; border-radius:8px; }
  .h-name { font-size:1.12rem; font-weight:800; letter-spacing:.2px; line-height:1.15; }
  .h-date { font-size:.78rem; color:var(--dim); margin-top:2px; }
  /* Next line */
  .next { display:flex; align-items:baseline; justify-content:space-between; gap:10px;
          padding:11px 16px; border-bottom:1px solid var(--line); }
  .next-l { font-size:.9rem; color:var(--dim); } .next-l b { color:var(--gold); font-weight:800; }
  .next-c { font-weight:800; font-variant-numeric:tabular-nums; letter-spacing:.5px; }
  /* Prayer rows */
  .rows { display:block; }
  .prow { display:grid; grid-template-columns:minmax(0,1fr) auto auto; align-items:center; gap:10px;
          padding:11px 16px; border-bottom:1px solid var(--line); }
  .prow:last-child { border-bottom:0; }
  .prow.on { background:var(--primary-soft); box-shadow:inset 3px 0 0 0 var(--primary); }
  .p-name { font-weight:700; min-width:0; } .p-name .ar { color:var(--gold); font-weight:600; margin-inline-start:7px; font-size:.92em; }
  .prow.on .p-name { color:var(--primary); }
  .prow.jm .p-name { color:var(--gold); }
  .p-ad { color:var(--dim); font-variant-numeric:tabular-nums; text-align:end; min-width:60px; }
  .p-iq { font-weight:800; color:var(--primary); font-variant-numeric:tabular-nums; text-align:end; min-width:60px; }
  .p-iq.none { color:var(--faint); font-weight:600; }
  .p-one { grid-column:2 / 4; text-align:end; font-weight:800; color:var(--gold); font-variant-numeric:tabular-nums; }
  .cols { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:10px; padding:8px 16px; border-bottom:1px solid var(--line);
          font-size:.66rem; letter-spacing:.12em; text-transform:uppercase; color:var(--faint); }
  .cols span:not(:first-child){ text-align:end; min-width:60px; }
  /* Week panel */
  .wk-nav { display:flex; align-items:center; gap:8px; padding:12px 14px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  .btn { border:1px solid var(--line); background:var(--card); color:var(--ink); border-radius:10px;
         padding:7px 11px; font:inherit; font-size:.82rem; font-weight:600; cursor:pointer; }
  .btn:hover:not(:disabled){ background:var(--hover); } .btn:disabled{ opacity:.4; cursor:default; }
  .wk-sel { border:1px solid var(--line); background:var(--card); color:var(--ink); border-radius:10px;
            padding:7px 10px; font:inherit; font-size:.82rem; font-weight:600; }
  .wk-range { color:var(--dim); font-size:.8rem; margin-inline-start:auto; }
  table.wk { width:100%; min-width:300px; border-collapse:collapse; font-size:.74rem; }
  table.wk th { color:var(--faint); font-weight:700; text-transform:uppercase; letter-spacing:.04em; font-size:.6rem;
                padding:8px 5px; text-align:center; border-bottom:1px solid var(--line); }
  table.wk th:first-child, table.wk td:first-child { text-align:start; padding-inline-start:12px; }
  table.wk td { padding:8px 5px; text-align:center; border-bottom:1px solid var(--line); font-variant-numeric:tabular-nums; color:var(--dim); }
  table.wk tr:last-child td { border-bottom:0; }
  table.wk td.day { color:var(--ink); font-weight:700; white-space:nowrap; }
  table.wk tr { cursor:pointer; }
  table.wk tr:hover td { background:var(--hover); }
  table.wk tr.today td { background:var(--primary-soft); }
  table.wk tr.today td.day { color:var(--primary); }
  table.wk tr.focus td { box-shadow:inset 0 0 0 1.5px var(--primary); }
  .foot { text-align:center; font-size:.66rem; color:var(--faint); padding:8px; }
  .foot a { color:inherit; text-decoration:none; }
</style>
</head>
<body>
<div class="omw" id="omw"></div>
<script>
(function(){
  var JSON_URL = ${JSON.stringify(jsonPath)};
  var d = ${JSON.stringify(data).replace(/</g, '\\u003c')};
  var state = { date: d.focus.iso, week: d.week.startIso };
  var cdEnd = null; // client-clock ms when the next prayer arrives (today only)
  var tickTimer = null, pollTimer = null;

  function E(t,c,txt){ var e=document.createElement(t); if(c)e.className=c; if(txt!=null)e.textContent=txt; return e; }
  function shiftIso(iso,days){ var p=iso.split('-'); var dt=new Date(Date.UTC(+p[0],+p[1]-1,+p[2])); dt.setUTCDate(dt.getUTCDate()+days); return dt.toISOString().slice(0,10); }
  function fmtCd(sec){ if(sec<0)sec=0; var h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60; function p(n){return (n<10?'0':'')+n;}
    return h>0 ? h+'h '+p(m)+'m' : m>0 ? m+'m '+p(s)+'s' : s+'s'; }

  // The masjid's uploaded logo (data URI), embedded once at render time. Falls
  // back to the built-in dome mark when the masjid hasn't uploaded a logo.
  var LOGO = ${JSON.stringify(logo || '')};
  var mark = '<svg class="mark" viewBox="0 0 48 48" fill="currentColor" aria-hidden="true">'+
    '<path d="M24 3c1.6 0 3 .6 4 1.6A5.6 5.6 0 0 0 24 14a5.6 5.6 0 0 0 4-1.4A5.8 5.8 0 0 1 24 3Z"/>'+
    '<path d="M12 26c0-8 5.4-12 12-12s12 4 12 12v2H12v-2Z" opacity=".9"/>'+
    '<path d="M10 28h28v15H10V28Zm10 15V36a4 4 0 0 1 8 0v7h-8Z" opacity=".55"/></svg>';
  function markEl(){
    if(LOGO){ var im=E('img','mark'); im.src=LOGO; im.alt=''; return im; }
    var mk=E('div'); mk.innerHTML=mark; return mk.firstChild;
  }

  function todayCard(){
    var f=d.focus, card=E('div','card');
    var head=E('div','head'); head.appendChild(markEl());
    var ht=E('div'); ht.appendChild(E('div','h-name', d.masjidName));
    var dt=(f.gregorian||'')+(f.hijri?'  ·  '+f.hijri:''); if(dt.trim()) ht.appendChild(E('div','h-date', dt));
    head.appendChild(ht); card.appendChild(head);

    if(f.isToday && f.next){
      var nx=E('div','next'); var nl=E('div','next-l'); nl.appendChild(document.createTextNode('Next: ')); nl.appendChild(E('b',null,f.next.label));
      nx.appendChild(nl); var nc=E('div','next-c'); nc.id='omw-cd'; nc.textContent=fmtCd(f.next.inSeconds); nx.appendChild(nc);
      card.appendChild(nx);
    }
    var cols=E('div','cols'); cols.appendChild(E('span',null,'Prayer')); cols.appendChild(E('span',null,'Adhan')); cols.appendChild(E('span',null,'Iqamah')); card.appendChild(cols);

    var rows=E('div','rows');
    (f.rows||[]).forEach(function(r){
      var jm=r.key.indexOf('jumuah')===0;
      var row=E('div','prow'+(r.next?' on':'')+(jm?' jm':''));
      var nm=E('div','p-name'); nm.appendChild(document.createTextNode(r.label)); if(r.sub){ var s=E('span','ar',r.sub); nm.appendChild(s);} row.appendChild(nm);
      if(r.adhan && r.iqamah){ row.appendChild(E('div','p-ad', r.adhan)); row.appendChild(E('div','p-iq', r.iqamah)); }
      else if(r.iqamah && !r.adhan){ row.appendChild(E('div','p-one', r.iqamah)); }
      else { row.appendChild(E('div','p-ad', r.adhan||'')); row.appendChild(E('div','p-iq'+(r.iqamah?'':' none'), r.iqamah||'—')); }
      rows.appendChild(row);
    });
    card.appendChild(rows);
    return card;
  }

  function weekPanel(){
    var w=d.week, card=E('div','card');
    var nav=E('div','wk-nav');
    var prev=E('button','btn','‹ Prev'); prev.onclick=function(){ go(state.date, shiftIso(state.week,-7)); };
    var sel=E('select','wk-sel');
    [['This week',0],['Next week',7],['In 2 weeks',14],['In 3 weeks',21],['Last week',-7]].forEach(function(o){
      var op=E('option',null,o[0]); op.value=shiftIso(baseWeek,o[1]); if(op.value===state.week) op.selected=true; sel.appendChild(op);
    });
    sel.onchange=function(){ go(state.date, sel.value); };
    var next=E('button','btn','Next ›'); next.onclick=function(){ go(state.date, shiftIso(state.week,7)); };
    var range=E('div','wk-range', w.label);
    nav.appendChild(prev); nav.appendChild(sel); nav.appendChild(next); nav.appendChild(range); card.appendChild(nav);

    var tbl=E('table','wk');
    var thead=E('thead'); var htr=E('tr'); ['Day','Fajr','Dhuhr','Asr','Maghrib','Isha'].forEach(function(h){ htr.appendChild(E('th',null,h)); }); thead.appendChild(htr); tbl.appendChild(thead);
    var tb=E('tbody');
    (w.days||[]).forEach(function(day){
      var tr=E('tr',(day.isToday?'today ':'')+(day.isFocus?'focus':'')); tr.onclick=function(){ go(day.iso, state.week); };
      tr.appendChild(E('td','day',day.dayLabel));
      [day.fajr,day.dhuhr,day.asr,day.maghrib,day.isha].forEach(function(t){ tr.appendChild(E('td',null,t)); });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); var sc=E('div','wk-scroll'); sc.appendChild(tbl); card.appendChild(sc);
    return card;
  }

  var baseWeek; // the "This week" anchor for the selector (today's week)
  function render(){
    var root=document.getElementById('omw'); if(!root) return;
    document.documentElement.setAttribute('dir', d.rtl?'rtl':'ltr');
    if(!baseWeek) baseWeek = d.week.startIso; // first payload = today/this week
    root.innerHTML='';
    root.appendChild(todayCard());
    root.appendChild(weekPanel());
    var f=E('div','foot'); var a=E('a',null,'OpenMasjid Display'); a.href='https://github.com/OpenMasjid-Solutions'; a.target='_blank'; a.rel='noopener'; f.appendChild(a); root.appendChild(f);
    // Live countdown (today only).
    if(tickTimer){ clearInterval(tickTimer); tickTimer=null; }
    if(d.focus.isToday && d.focus.next){
      cdEnd = Date.now() + d.focus.next.inSeconds*1000;
      tickTimer=setInterval(function(){ var el=document.getElementById('omw-cd'); if(!el){clearInterval(tickTimer);return;}
        var left=Math.round((cdEnd-Date.now())/1000); el.textContent=fmtCd(left); if(left<=0){ load(); } }, 1000);
    }
  }

  function url(date,week){ var sep=JSON_URL.indexOf('?')>=0?'&':'?'; return JSON_URL+sep+'date='+encodeURIComponent(date)+'&week='+encodeURIComponent(week); }
  function load(){ fetch(url(state.date,state.week),{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){ d=j; state.date=j.focus.iso; state.week=j.week.startIso; render(); }).catch(function(){}); }
  function go(date,week){ state.date=date; state.week=week; load(); }

  render();
  pollTimer=setInterval(load, 30000); // keep times + countdown fresh
})();
</script>
</body>
</html>`;
}
