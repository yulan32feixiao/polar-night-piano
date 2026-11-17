"use strict";
/* 极夜钢琴：库乐队式电子钢琴 + 下落音符练习。
   - 难度 = 琴键数量（JP.LEVELS）
   - 不等人：音符照节拍落下，按准了加分，漏了就过去
   - 速度可调、节拍器、示范、全屏（Esc 退出）、曲谱可编辑 */

const $ = id => document.getElementById(id);
const TOUCH = matchMedia("(pointer:coarse)").matches || navigator.maxTouchPoints > 1;
const W_PERFECT = 0.09, W_GOOD = 0.18, W_MISS = 0.2;     /* 判定窗口，真实秒数（不随速度变） */
const LOOK = 2.6;                                          /* 音符从出现到落到琴键，真实秒数 */

/* ================= 设置与曲库（存在本机浏览器） ================= */
const S = {tilt: "auto", kbSize: 0.25, song: "ode", level: "l2", speed: 1, metroOn: false, metroBpm: 90, label: "jianpu"};
try { Object.assign(S, JSON.parse(localStorage.getItem("pk2.set") || "{}")); } catch (e) {}
const saveS = () => { try { localStorage.setItem("pk2.set", JSON.stringify(S)); } catch (e) {} };

let songs;
try { songs = JSON.parse(localStorage.getItem("pk2.songs") || "null"); } catch (e) {}
if (Array.isArray(songs)) songs = songs.filter(s => s && s.id !== "twinkle");   /* 小星星已下架 */
if (!Array.isArray(songs) || !songs.length) songs = structuredClone(BUILTIN_SONGS);
const saveSongs = () => { try { localStorage.setItem("pk2.songs", JSON.stringify(songs)); } catch (e) {} };
const curSong = () => songs.find(s => s.id === S.song) || songs[0];

/* ================= 谱面 ================= */
let chart = null;         /* {mel:[{t,d,m,lab}], acc:[{t,d,m}], dur, spb, bpb, lo, hi, base} */
function buildChart(){
  const sg = curSong();
  S.song = sg.id;
  const mp = JP.parse(sg.mel, sg.key), ap = JP.parse(sg.acc, sg.key);
  const fit = JP.fit(mp.notes.map(n => n.m), S.level);
  const spb = 60 / (sg.bpm || 90);
  chart = {
    name: sg.name, spb, bpb: JP.beatsPerBar(sg.meter), lo: fit.lo, hi: fit.hi,
    base: 60 + JP.keyOffset(sg.key) + fit.shift,      /* 简谱 "1" 在哪个音 */
    mel: mp.notes.map(n => ({t: n.b * spb, d: n.d * spb, m: fit.map(n.m)})),
    acc: ap.notes.map(n => ({t: n.b * spb, d: n.d * spb, m: n.m + fit.shift})),
    dur: Math.max(mp.beats, ap.beats) * spb,
    shift: fit.shift,
  };
  chart.mel.sort((a, b) => a.t - b.t || a.m - b.m);
  /* 电脑键盘控制的那个八度：覆盖最多旋律音的 C */
  let best = -1;
  for (let c = 24; c <= 96; c += 12){
    const n = chart.mel.filter(x => x.m >= c && x.m <= c + 17).length;
    if (n > best){ best = n; kbdBase = c; }
  }
  if (!chart.mel.length) kbdBase = Math.floor(chart.lo / 12) * 12 + 12 > chart.hi ? Math.floor(chart.lo / 12) * 12 : Math.ceil(chart.lo / 12) * 12;
}

/* ================= 琴键 ================= */
const keysEl = $("keys");
let kgeo = [];              /* [{m, x, w, black, el}] 相对 #keys 的坐标 */
const kByM = new Map();
let kbdBase = 60;

const LAB_J = ["1","#1","2","#2","3","4","#4","5","#5","6","#6","7"];
const LAB_N = ["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];
const KMAP = {KeyA:0,KeyW:1,KeyS:2,KeyE:3,KeyD:4,KeyF:5,KeyT:6,KeyG:7,KeyY:8,KeyH:9,KeyU:10,KeyJ:11,
              KeyK:12,KeyO:13,KeyL:14,KeyP:15,Semicolon:16,Quote:17};
const KCAP = {}; for (const [c, i] of Object.entries(KMAP)) KCAP[i] = c === "Semicolon" ? ";" : c === "Quote" ? "'" : c.slice(3);

/* 一个音在琴键/方块上显示的字；html=true 时简谱带高低音点 */
function label(m, html){
  if (S.label === "none") return "";
  if (S.label === "name"){
    const pc = ((m % 12) + 12) % 12;
    return LAB_N[pc] + (pc === 0 ? (html ? "<sub>" + (Math.floor(m / 12) - 1) + "</sub>" : "") : "");
  }
  if (S.label === "kbd"){
    const i = m - kbdBase;
    return KCAP[i] !== undefined ? KCAP[i] : "";
  }
  const rel = m - chart.base, pc = ((rel % 12) + 12) % 12, oc = Math.floor(rel / 12);
  const d = LAB_J[pc];
  if (!html) return d;
  const dots = n => '<span class="o">' + "•".repeat(Math.min(2, n)) + "</span>";
  return dots(Math.max(0, oc)) + d + dots(Math.max(0, -oc));
}

/* 琴键按真钢琴比例：白键宽 = 键高 / 4.6，黑键宽 0.58、长 0.62。
   键不会被拉宽去填满屏幕；屏幕多出来的地方就多显示几个键（灰色，范围外）。
   难度范围比屏幕宽时，可以拖上面的小条滑动，演奏时自动跟着音符走。 */
let scrollX = 0, maxScroll = 0, totalW = 0, tilted = false;
const keysIn = document.createElement("div");
keysIn.id = "keysIn";
function buildKeys(){
  keysIn.innerHTML = ""; kgeo = []; kByM.clear();
  if (!keysIn.parentNode) keysEl.appendChild(keysIn);
  const W = keysEl.clientWidth, KH = keysEl.clientHeight;
  /* 斜看：琴键往后倒，屏幕上占的高度不变，但键本身更长 → 按比例可以更宽 */
  tilted = S.tilt === "tilt" || (S.tilt === "auto" && innerWidth > innerHeight);
  const TH = 55 * Math.PI / 180, P = 1600;
  const D = tilted ? KH * P / (P * Math.cos(TH) + KH * Math.sin(TH)) : KH;
  keysEl.classList.toggle("tilt", tilted);
  keysEl.style.perspective = tilted ? P + "px" : "";
  keysEl.style.perspectiveOrigin = "50% 0";
  keysIn.style.height = D + "px";
  const ww = Math.max(16, D / 4.6), bw = ww * 0.58;
  const whitesIn = (a, b) => { let n = 0; for (let m = a; m <= b; m++) if (!JP.isBlack(m)) n++; return n; };
  /* 显示范围 = 难度范围，不够铺满屏幕就往两边各加白键 */
  let dLo = chart.lo, dHi = chart.hi, flip = 0;
  const need = Math.ceil(W / ww);
  while (whitesIn(dLo, dHi) < need && (dLo > 21 || dHi < 108)){
    if ((flip++ % 2 === 0 && dLo > 21) || dHi >= 108){ do dLo--; while (JP.isBlack(dLo)); }
    else { do dHi++; while (JP.isBlack(dHi)); }
  }
  const whites = [];
  for (let m = dLo; m <= dHi; m++) if (!JP.isBlack(m)) whites.push(m);
  whites.forEach((m, i) => kgeo.push({m, x: i * ww, w: ww, black: false}));
  for (let m = dLo + 1; m < dHi; m++){
    if (!JP.isBlack(m)) continue;
    kgeo.push({m, x: (whites.indexOf(m - 1) + 1) * ww - bw / 2, w: bw, black: true});
  }
  totalW = whites.length * ww;
  keysIn.style.width = totalW + "px";
  const fs = Math.max(9, Math.min(14, ww * 0.3));
  for (const k of kgeo){
    const d = document.createElement("div");
    const out = k.m < chart.lo || k.m > chart.hi;
    d.className = "k " + (k.black ? "b" : "w") + (out ? " out" : "");
    d.style.left = k.x + "px"; d.style.width = (k.black ? k.w : k.w + 0.5) + "px";
    d.dataset.m = k.m;
    if (!out && !(k.black && bw < 18)){
      const lb = document.createElement("span");
      lb.className = "lb"; lb.innerHTML = label(k.m, true);
      lb.style.fontSize = (k.black ? fs * 0.78 : fs) + "px";
      d.appendChild(lb);
    }
    keysIn.appendChild(d);
    k.el = d; kByM.set(k.m, k);
  }
  /* 电脑键盘控制范围的小紫条 */
  if (!TOUCH){
    const a = kByM.get(kbdBase) || kgeo.find(k => k.m >= kbdBase);
    const z = [...kgeo].reverse().find(k => k.m <= kbdBase + 17);
    if (a && z && z.x > a.x){
      const bar = document.createElement("div");
      bar.className = "kbd-range";
      bar.style.left = a.x + "px"; bar.style.width = (z.x + z.w - a.x) + "px";
      bar.title = "电脑键盘 A–' 控制这一段，Z / X 换八度";
      keysIn.appendChild(bar);
    }
  }
  for (const m of downNotes.keys()) kByM.get(m)?.el.classList.add("on");
  /* 先把难度范围放到屏幕中间 */
  maxScroll = Math.max(0, totalW - W);
  const lo = kByM.get(chart.lo), hi = kByM.get(chart.hi);
  scrollX = lo && hi ? (lo.x + hi.x + hi.w) / 2 - W / 2 : 0;
  buildNav();
  applyScroll();
}
function applyScroll(){
  scrollX = Math.max(0, Math.min(maxScroll, scrollX));
  keysIn.style.transform = "translateX(" + (-scrollX) + "px)" + (tilted ? " rotateX(55deg)" : "");
  const th = $("navThumb");
  if (th && totalW) { th.style.left = (scrollX / totalW * 100) + "%"; th.style.width = (keysEl.clientWidth / totalW * 100) + "%"; }
}
/* 滑动条：整个显示范围的缩略，紫色是难度范围，白框是屏幕上看到的部分 */
function buildNav(){
  const nav = $("nav");
  const lo = kByM.get(chart.lo), hi = kByM.get(chart.hi);
  /* 难度范围在屏幕里放得下就不显示滑动条 */
  nav.hidden = maxScroll < 2 || (hi.x + hi.w - lo.x) <= keysEl.clientWidth - 4;
  if (nav.hidden) return;
  $("navBand").style.left = (lo.x / totalW * 100) + "%";
  $("navBand").style.width = ((hi.x + hi.w - lo.x) / totalW * 100) + "%";
}
{
  const nav = $("nav");
  let drag = null;
  const go = e => { const r = nav.getBoundingClientRect(); scrollX = (e.clientX - r.left) / r.width * totalW - keysEl.clientWidth / 2; applyScroll(); };
  nav.addEventListener("pointerdown", e => { e.preventDefault(); drag = e.pointerId; try { nav.setPointerCapture(drag); } catch (err) {} go(e); });
  nav.addEventListener("pointermove", e => { if (drag === e.pointerId) go(e); });
  for (const ev of ["pointerup", "pointercancel"]) nav.addEventListener(ev, () => { drag = null; });
  keysEl.addEventListener("wheel", e => {
    if (!maxScroll) return;
    e.preventDefault(); scrollX += e.deltaX || e.deltaY; applyScroll();
  }, {passive: false});
}
/* 演奏时：接下来要弹的音不在屏幕里，就慢慢滑过去 */
function follow(now){
  if (maxScroll < 2) return;
  let a = Infinity, b = -Infinity;
  for (const n of chart.mel){
    if (n.t < now - 0.1) continue;
    if (n.t > now + LOOK * S.speed * 0.8) break;
    const k = kByM.get(n.m); if (!k) continue;
    a = Math.min(a, k.x); b = Math.max(b, k.x + k.w);
  }
  if (a > b) return;
  const W = keysEl.clientWidth, pad = 30;
  let target = scrollX;
  if (a < scrollX + pad || b > scrollX + W - pad) target = (a + b) / 2 - W / 2;
  if (Math.abs(target - scrollX) > 0.5){ scrollX += (target - scrollX) * 0.08; applyScroll(); }
}

function keyAt(cx, cy){
  if (tilted){
    /* 斜着的琴键交给浏览器算点到哪个键（黑键在上层，优先） */
    const r = keysEl.getBoundingClientRect();
    if (cx < r.left || cx > r.right) return null;
    const e = document.elementFromPoint(cx, Math.min(cy, r.bottom - 1));
    const k = e && e.closest && e.closest(".k");
    return k && keysIn.contains(k) ? +k.dataset.m : null;
  }
  const r = keysEl.getBoundingClientRect();
  const x = cx - r.left + scrollX, y = cy - r.top;
  if (cx < r.left || cx > r.right || y < -6 || y > r.height + 20) return null;
  for (const k of kgeo) if (k.black && x >= k.x && x <= k.x + k.w && y <= r.height * 0.62) return k.m;
  for (const k of kgeo) if (!k.black && x >= k.x && x < k.x + k.w) return k.m;
  return null;
}

/* ================= 发声 + 判定 ================= */
const downNotes = new Map();      /* m -> 声音句柄 */
let state = "idle";               /* idle | play | pause | done */
let anchorAc = 0, anchorSong = 0;
const songNow = () => anchorSong + (AU.ctx.currentTime - anchorAc) * S.speed;
const acAt = t => anchorAc + (t - anchorSong) / S.speed;    /* 谱面时间 → 声卡时间 */
let stats, flashes = [];

function press(m, vel){
  AU.init();
  if (downNotes.has(m)) downNotes.get(m).release();
  downNotes.set(m, AU.strike(m, vel ?? 0.8));
  kByM.get(m)?.el.classList.add("on");
  if (state === "play" && !demo) judge(m);
}
function release(m){
  const h = downNotes.get(m); if (!h) return;
  h.release(); downNotes.delete(m);
  kByM.get(m)?.el.classList.remove("on");
}

function judge(m){
  const now = songNow();
  let best = null;
  for (const n of chart.mel){
    if (n.j || n.m !== m) continue;
    const off = (n.t - now) / S.speed;
    if (off > W_GOOD) break;
    if (Math.abs(off) <= W_GOOD && (!best || Math.abs(off) < Math.abs((best.t - now) / S.speed))) best = n;
  }
  if (!best) return;                                   /* 按了谱上没有的音：就是弹琴，不扣分 */
  const off = Math.abs((best.t - now) / S.speed);
  best.j = off <= W_PERFECT ? "p" : "g";
  stats[best.j]++; stats.combo++; stats.best = Math.max(stats.best, stats.combo);
  showJudge(best.j === "p" ? "Perfect" : "Good", best.j === "p" ? "#7A5CF0" : "#3BAE8E");
  const k = kByM.get(m); if (k) flashes.push({x: k.x, w: k.w, t: performance.now()});
  updStats();
}
function showJudge(txt, col){
  const j = $("judge");
  j.textContent = txt; j.style.color = col;
  j.classList.remove("on"); void j.offsetWidth; j.classList.add("on");
}
function updStats(){
  const n = stats.p + stats.g + stats.m;
  $("mCombo").textContent = stats.combo;
  $("mAcc").textContent = demo ? "示范" : n ? Math.round((stats.p + stats.g * 0.6) / n * 100) + "%" : "—";
}

/* ================= 节拍器 ================= */
let metroNext = null, freeAnchor = 0;
function metroTick(){
  const ac = AU.ctx; if (!ac) return;
  const ahead = ac.currentTime + 0.12;
  if (state === "play"){
    /* 拍子跟着谱面时间走；预备拍总是响，正式部分看开关 */
    const spb = chart.spb;
    if (metroNext === null) metroNext = Math.ceil((songNow() - 0.001) / spb);
    while (acAt(metroNext * spb) < ahead){
      const k = metroNext++;
      if (k < 0 || S.metroOn) beep(acAt(k * spb), ((k % chart.bpb) + chart.bpb) % chart.bpb === 0);
    }
  } else if (S.metroOn && state !== "pause"){
    const spb = 60 / S.metroBpm;
    if (metroNext === null){ freeAnchor = ac.currentTime + 0.05; metroNext = 0; }
    while (freeAnchor + metroNext * spb < ahead){
      const k = metroNext++;
      beep(freeAnchor + k * spb, k % 4 === 0);
    }
  }
}
function beep(when, accent){
  AU.click(when, accent);
  const dot = $("metroDot"), ms = Math.max(0, (when - AU.ctx.currentTime) * 1000);
  setTimeout(() => {
    dot.classList.add("tick"); dot.classList.toggle("accent", accent);
    setTimeout(() => dot.classList.remove("tick", "accent"), 90);
  }, ms);
}

/* ================= 流程 ================= */
let demo = false, pausedAt = 0;
function resetRun(){
  for (const n of chart.mel){ delete n.j; delete n.fired; }
  for (const n of chart.acc) delete n.fired;
  stats = {p: 0, g: 0, m: 0, combo: 0, best: 0};
  flashes = [];
  updStats();
}
function countInBeats(){
  const bar = chart.bpb * chart.spb;
  return chart.bpb * Math.max(1, Math.ceil(1.6 / bar));
}
function start(){
  const ac = AU.init();
  resetRun();
  runFrom(-countInBeats() * chart.spb, ac);
}
function runFrom(t, ac){
  ac = ac || AU.init();
  anchorSong = t; anchorAc = ac.currentTime + 0.06;
  metroNext = null;
  state = "play";
  document.body.classList.add("playing");
  $("card").hidden = true;
}
function pause(){
  if (state !== "play") return;
  pausedAt = songNow();
  state = "pause";
  metroNext = null;
  showCard();
}
function resume(){
  /* 往回退一小节再接着走，给你准备时间 */
  const back = Math.max(chart.bpb * chart.spb, 1.2 * S.speed);
  const from = Math.max(-countInBeats() * chart.spb, pausedAt - back);
  for (const n of chart.acc) if (n.t >= from) delete n.fired;
  for (const n of chart.mel) if (n.t >= from && n.fired) delete n.fired;
  runFrom(from);
}
function stop(){
  state = "idle"; metroNext = null;
  resetRun();
  showCard();
}
function finish(){
  state = "done"; metroNext = null;
  showCard();
}

function showCard(){
  document.body.classList.toggle("playing", false);
  $("count").textContent = "";
  const sg = curSong(), L = JP.LEVELS.find(l => l.id === S.level);
  const c = $("card"); c.hidden = false;
  $("stopBtn").hidden = state !== "pause" && state !== "done";
  $("cardHint").hidden = state !== "idle";
  if (state === "pause"){
    $("cardK").textContent = "暂停";
    $("cardTitle").textContent = sg.name;
    $("cardText").innerHTML = "可以先调速度、难度、节拍器，再继续。<br>继续时会往回退一点，给你准备。";
    $("goBtn").textContent = "▶ 继续";
    return;
  }
  if (state === "done"){
    const tot = stats.p + stats.g + stats.m;
    const acc = tot ? (stats.p + stats.g * 0.6) / tot : 0;
    const grade = demo ? "示范结束" : acc >= .95 ? "S" : acc >= .85 ? "A" : acc >= .7 ? "B" : acc >= .5 ? "C" : "再练练";
    $("cardK").textContent = "完成 · " + sg.name;
    $("cardTitle").textContent = grade;
    $("cardText").innerHTML = demo ? "看完示范了，关掉「示范」自己弹一遍。" :
      "准度 <b>" + Math.round(acc * 100) + "%</b> · Perfect " + stats.p + " · Good " + stats.g + " · 漏掉 " + stats.m +
      "<br>最高连击 " + stats.best + (acc >= .9 && S.level !== "l5" ? "。可以试试更高难度或更快速度。" : "");
    $("goBtn").textContent = "↻ 再来一次";
    return;
  }
  const nKeys = kgeo.length;
  $("cardK").textContent = L.name + " · 用 " + L.keys + " 个" + (L.whites ? "白键" : "键");
  $("cardTitle").textContent = sg.name;
  $("cardText").innerHTML =
    "1=" + sg.key.replace("#", "♯").replace("b", "♭") + " · " + sg.meter + " · " + sg.bpm + " BPM" +
    (S.speed !== 1 ? "（现在 " + Math.round(S.speed * 100) + "% 速度）" : "") + "<br>" +
    "紫色方块落到琴键上沿的时候按下去。先响一小节预备拍。" +
    (TOUCH ? "" : "<br>电脑：<b>A S D F G H J K</b> 是白键，<b>W E T Y U</b> 是黑键，<b>Z / X</b> 换八度，空格开始/暂停。");
  $("goBtn").textContent = "▶ 开始";
}

/* ================= 每一帧 ================= */
const cv = $("hwy"), ctx = cv.getContext("2d");
const stage = $("stage");
let cvW = 0, cvH = 0, kOff = 0;
function sizeCanvas(){
  const dpr = Math.min(2, devicePixelRatio || 1);
  cvW = stage.clientWidth; cvH = stage.clientHeight;
  cv.width = Math.round(cvW * dpr); cv.height = Math.round(cvH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  kOff = keysEl.getBoundingClientRect().left - stage.getBoundingClientRect().left;
}

function frame(){
  requestAnimationFrame(frame);
  const ac = AU.ctx;
  let now;
  if (state === "play" && ac){
    now = songNow();
    const ahead = acAt(now) + 0.1;
    /* 左手伴奏 + 示范：提前一点排进声卡，节奏才稳 */
    for (const n of chart.acc){
      if (n.fired) continue;
      if (n.t < now - 0.3){ n.fired = true; continue; }
      if (acAt(n.t) > ac.currentTime + 0.1) break;
      n.fired = true;
      const h = AU.strike(n.m, 0.42, acAt(n.t));
      h.release(acAt(n.t + n.d));
    }
    if (demo){
      for (const n of chart.mel){
        if (n.fired) continue;
        if (acAt(n.t) > ac.currentTime + 0.1) break;
        n.fired = true; n.j = "d";
        if (n.t < now - 0.3) continue;
        const h = AU.strike(n.m, 0.75, acAt(n.t));
        h.release(acAt(n.t + n.d * 0.95));
        const k = kByM.get(n.m), delay = Math.max(0, (acAt(n.t) - ac.currentTime) * 1000);
        if (k){
          setTimeout(() => k.el.classList.add("demo"), delay);
          setTimeout(() => k.el.classList.remove("demo"), delay + Math.max(120, n.d / S.speed * 1000 * 0.9));
        }
      }
    } else {
      for (const n of chart.mel){
        if (n.j) continue;
        if ((now - n.t) / S.speed > W_MISS){
          n.j = "m"; stats.m++; stats.combo = 0; showJudge("Miss", "#C7A2B0"); updStats();
        } else break;
      }
    }
    void ahead;
    /* 预备拍数字 */
    $("count").textContent = now < 0 ? Math.ceil(-now / chart.spb - 1e-6) : "";
    $("progBar").style.width = Math.max(0, Math.min(100, now / chart.dur * 100)) + "%";
    if (now > chart.dur + 0.6 * S.speed) finish();
  } else if (state === "pause"){
    now = pausedAt;
  } else {
    now = -LOOK * S.speed * 0.35;
  }
  metroTick();
  if (state === "play") follow(now);
  markTargets(state === "play" ? now : null);
  draw(now);
}

let lastTargets = new Set();
function markTargets(now){
  const t = new Set();
  if (now !== null && !demo){
    for (const n of chart.mel){
      if (n.t - now > 0.28 * S.speed) break;
      if (!n.j && n.t - now > -W_GOOD * S.speed) t.add(n.m);
    }
  }
  for (const m of lastTargets) if (!t.has(m)) kByM.get(m)?.el.classList.remove("target");
  for (const m of t) if (!lastTargets.has(m)) kByM.get(m)?.el.classList.add("target");
  lastTargets = t;
}

function rr(x, y, w, h, r){
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}
function draw(now){
  const W = cvW, H = cvH;
  ctx.clearRect(0, 0, W, H);
  if (!chart) return;
  const span = LOOK * S.speed, pps = H / span, hitY = H;
  ctx.save(); ctx.translate(kOff - scrollX, 0);

  /* 轨道：白键之间细线，黑键轨道稍暗 */
  for (const k of kgeo){
    if (k.m < chart.lo || k.m > chart.hi){ ctx.fillStyle = "rgba(60,50,100,.10)"; ctx.fillRect(k.x, 0, k.w, H); continue; }
    if (k.black){ ctx.fillStyle = "rgba(70,55,130,.07)"; ctx.fillRect(k.x, 0, k.w, H); }
    else { ctx.fillStyle = "rgba(255,255,255,.28)"; ctx.fillRect(k.x + k.w - 0.5, 0, 1, H); }
  }
  /* 小节线 */
  const spb = chart.spb, bar = spb * chart.bpb;
  const totalW = kgeo.length ? Math.max(...kgeo.map(k => k.x + k.w)) : W;
  for (let i = Math.ceil(now / spb); ; i++){
    const y = hitY - (i * spb - now) * pps;
    if (y < 0) break;
    const isBar = Math.abs((i * spb) % bar) < 1e-6 || Math.abs((i * spb) % bar - bar) < 1e-6;
    ctx.fillStyle = isBar ? "rgba(255,255,255,.55)" : "rgba(255,255,255,.18)";
    ctx.fillRect(0, y, totalW, isBar ? 1.5 : 1);
  }

  /* 音符方块 */
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  for (const n of chart.mel){
    const bottom = hitY - (n.t - now) * pps;
    if (bottom < -10) break;
    const h = Math.max(14, n.d * pps - 3), top = bottom - h;
    if (top > H) continue;
    const k = kByM.get(n.m); if (!k) continue;
    if (n.j === "p" || n.j === "g") continue;           /* 弹中的直接消失（有光效） */
    const inset = k.black ? 1 : 3;
    const x = k.x + inset, w = k.w - inset * 2;
    if (n.j === "m"){
      ctx.fillStyle = "rgba(120,110,150,.28)";
    } else if (n.j === "d"){
      ctx.fillStyle = "rgba(59,174,142,.55)";
    } else {
      const g = ctx.createLinearGradient(0, top, 0, bottom);
      if (k.black){ g.addColorStop(0, "#7F67E8"); g.addColorStop(1, "#5236C8"); }
      else { g.addColorStop(0, "#B3A2FF"); g.addColorStop(1, "#7A5CF0"); }
      ctx.fillStyle = g;
    }
    rr(x, top, w, h, Math.min(7, w / 3)); ctx.fill();
    if (!n.j){
      ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 1; ctx.stroke();
      const t = label(n.m, false);
      if (t && h > 18 && w > 12){
        ctx.fillStyle = "#fff";
        ctx.font = "600 " + Math.min(15, Math.max(10, w * 0.38)) + "px -apple-system,PingFang SC,sans-serif";
        ctx.fillText(t, x + w / 2, bottom - 6);
      }
    }
  }

  /* 弹中的光 */
  const tn = performance.now();
  flashes = flashes.filter(f => tn - f.t < 280);
  for (const f of flashes){
    const a = 1 - (tn - f.t) / 280;
    const g = ctx.createLinearGradient(0, hitY - 90, 0, hitY);
    g.addColorStop(0, "rgba(168,148,255,0)"); g.addColorStop(1, "rgba(168,148,255," + (0.65 * a) + ")");
    ctx.fillStyle = g; ctx.fillRect(f.x, hitY - 90, f.w, 90);
  }
  ctx.restore();

  /* 判定线 = 琴键上沿 */
  const lg = ctx.createLinearGradient(0, hitY - 26, 0, hitY);
  lg.addColorStop(0, "rgba(255,255,255,0)"); lg.addColorStop(1, "rgba(255,255,255,.35)");
  ctx.fillStyle = lg; ctx.fillRect(0, hitY - 26, W, 26);
}

/* ================= 输入：触屏 / 鼠标 ================= */
const ptr = new Map();          /* pointerId -> m */
const velAt = cy => { const r = keysEl.getBoundingClientRect(); return 0.45 + 0.55 * Math.min(1, Math.max(0, (cy - r.top) / r.height)); };
keysEl.addEventListener("pointerdown", e => {
  e.preventDefault();
  try { keysEl.setPointerCapture(e.pointerId); } catch (err) {}
  const m = keyAt(e.clientX, e.clientY);
  ptr.set(e.pointerId, m);
  if (m != null) press(m, velAt(e.clientY));
});
keysEl.addEventListener("pointermove", e => {
  if (!ptr.has(e.pointerId)) return;
  const old = ptr.get(e.pointerId), m = keyAt(e.clientX, e.clientY);
  if (m === old) return;
  ptr.set(e.pointerId, m);
  if (old != null && ![...ptr.values()].includes(old)) release(old);
  if (m != null) press(m, velAt(e.clientY));
});
const ptrEnd = e => {
  if (!ptr.has(e.pointerId)) return;
  const m = ptr.get(e.pointerId); ptr.delete(e.pointerId);
  if (m != null && ![...ptr.values()].includes(m)) release(m);
};
keysEl.addEventListener("pointerup", ptrEnd);
keysEl.addEventListener("pointercancel", ptrEnd);

/* ================= 输入：电脑键盘（库乐队“音乐键入”键位） ================= */
const kHeld = new Map();        /* code -> m */
const typing = () => { const a = document.activeElement; return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT"); };
addEventListener("keydown", e => {
  if (e.key === "Escape"){
    if (!$("editor").hidden){ closeEditor(); return; }
    if (!$("songPop").hidden){ $("songPop").hidden = true; return; }
    if (document.body.classList.contains("full")) exitFull();
    return;
  }
  if (typing() || !$("editor").hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.repeat) { if (e.code in KMAP || e.code === "Space") e.preventDefault(); return; }
  if (e.code === "Space"){ e.preventDefault(); goAction(); return; }
  if (e.code === "KeyZ" || e.code === "KeyX"){
    kbdBase = Math.max(24, Math.min(96, kbdBase + (e.code === "KeyZ" ? -12 : 12)));
    buildKeys(); return;
  }
  if (e.code in KMAP){
    e.preventDefault();
    const m = kbdBase + KMAP[e.code];
    kHeld.set(e.code, m);
    press(m, 0.8);
  }
});
addEventListener("keyup", e => {
  if (!kHeld.has(e.code)) return;
  const m = kHeld.get(e.code); kHeld.delete(e.code);
  if (![...kHeld.values()].includes(m)) release(m);
});
addEventListener("blur", () => { for (const m of [...downNotes.keys()]) release(m); kHeld.clear(); ptr.clear(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });
document.addEventListener("gesturestart", e => e.preventDefault());
for (const ev of ["touchend", "click"]) addEventListener(ev, () => AU.init(), {capture: true, passive: true});

/* ================= 顶栏控件 ================= */
function goAction(){
  if (state === "play") pause();
  else if (state === "pause") resume();
  else start();
}
$("goBtn").addEventListener("click", goAction);
$("stopBtn").addEventListener("click", stop);
$("pauseBtn").addEventListener("click", pause);

function renderLevels(){
  const seg = $("levelSeg"); seg.innerHTML = "";
  for (const L of JP.LEVELS){
    const b = document.createElement("button");
    b.innerHTML = L.name + "<small>" + L.keys + " 键</small>";
    b.setAttribute("aria-pressed", String(L.id === S.level));
    b.addEventListener("click", () => { S.level = L.id; saveS(); renderLevels(); loadSong(); });
    seg.appendChild(b);
  }
}
const SPEEDS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5];
function setSpeed(dir){
  let i = SPEEDS.indexOf(S.speed); if (i < 0) i = 5;
  i = Math.max(0, Math.min(SPEEDS.length - 1, i + dir));
  S.speed = SPEEDS[i]; saveS();
  $("spdVal").textContent = Math.round(S.speed * 100) + "%";
  if (state === "idle") showCard();
}
$("spdDown").addEventListener("click", () => setSpeed(-1));
$("spdUp").addEventListener("click", () => setSpeed(1));

function renderMetro(){
  $("metroBtn").setAttribute("aria-pressed", String(S.metroOn));
  $("bpmVal").textContent = S.metroBpm;
}
$("metroBtn").addEventListener("click", () => { AU.init(); S.metroOn = !S.metroOn; metroNext = null; saveS(); renderMetro(); });
const bpmStep = d => { S.metroBpm = Math.max(30, Math.min(220, S.metroBpm + d)); metroNext = null; saveS(); renderMetro(); };
$("bpmDown").addEventListener("click", () => bpmStep(-5));
$("bpmUp").addEventListener("click", () => bpmStep(5));

$("labelSel").addEventListener("change", e => { S.label = e.target.value; saveS(); buildKeys(); });
$("demoBtn").addEventListener("click", () => {
  demo = !demo; $("demoBtn").setAttribute("aria-pressed", String(demo)); $("demoBtn").textContent = demo ? "开" : "关";
  if (state !== "idle"){ state = "idle"; resetRun(); }
  showCard();
});

/* ---- 选曲 ---- */
function renderSongList(){
  const list = $("songList"); list.innerHTML = "";
  for (const sg of songs){
    const p = JP.parse(sg.mel, sg.key);
    const r = document.createElement("div");
    r.className = "pop-row" + (sg.id === S.song ? " cur" : "");
    r.innerHTML = '<div class="nm"><b></b><small></small></div>' + (BUILTIN_SONGS.some(b => b.id === sg.id) ? '<span class="tag">内置</span>' : "");
    r.querySelector("b").textContent = sg.name;
    r.querySelector("small").textContent = "1=" + sg.key + " · " + sg.meter + " · " + sg.bpm + " BPM · " + p.notes.length + " 个音";
    r.addEventListener("click", () => { S.song = sg.id; saveS(); $("songPop").hidden = true; loadSong(); });
    list.appendChild(r);
  }
}
$("songBtn").addEventListener("click", e => {
  e.stopPropagation();
  const p = $("songPop");
  if (p.hidden){ renderSongList(); p.hidden = false; } else p.hidden = true;
});
addEventListener("pointerdown", e => {
  const p = $("songPop");
  if (!p.hidden && !p.contains(e.target) && !$("songBtn").contains(e.target)) p.hidden = true;
});

function loadSong(){
  for (const m of [...downNotes.keys()]) release(m);
  buildChart();
  $("songName").textContent = chart.name;
  state = "idle"; resetRun();
  buildKeys(); sizeCanvas(); showCard();
}

/* ---- 全屏（Esc 退出） ---- */
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
function enterFull(){
  document.body.classList.add("full");
  const d = document.documentElement;
  const rq = d.requestFullscreen || d.webkitRequestFullscreen;
  if (rq) try { const p = rq.call(d); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}
function exitFull(){
  document.body.classList.remove("full");
  if (fsEl()){ const ex = document.exitFullscreen || document.webkitExitFullscreen; try { ex.call(document); } catch (e) {} }
}
$("fsBtn").addEventListener("click", () => fsEl() || document.body.classList.contains("full") ? exitFull() : enterFull());
for (const ev of ["fullscreenchange", "webkitfullscreenchange"])
  document.addEventListener(ev, () => { if (!fsEl()) document.body.classList.remove("full"); setTimeout(onResize, 60); });

/* ================= 曲谱编辑器 ================= */
let edId = null, listenStop = null;
function fillKeys(){
  const sel = $("edKey"); sel.innerHTML = "";
  for (const [k] of JP.KEYS){ const o = document.createElement("option"); o.value = k; o.textContent = "1=" + k; sel.appendChild(o); }
}
function openEditor(sg){
  if (state === "play") pause();
  edId = sg ? sg.id : null;
  const s = sg || {name: "新曲子", key: "C", meter: "4/4", bpm: 90, mel: "1 2 3 4 | 5 - - - |\n5 4 3 2 | 1 - - - |", acc: ""};
  $("edName").value = s.name; $("edKey").value = s.key; $("edMeter").value = s.meter;
  $("edBpm").value = s.bpm; $("edMel").value = s.mel; $("edAcc").value = s.acc || "";
  $("edDel").hidden = !sg;
  $("edReset").hidden = !(sg && BUILTIN_SONGS.some(b => b.id === sg.id));
  $("editor").hidden = false;
  validate();
}
function closeEditor(){ stopListen(); $("editor").hidden = true; }
const noteNm = m => LAB_N[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
function validate(){
  const key = $("edKey").value, bpb = JP.beatsPerBar($("edMeter").value);
  const a = JP.parse($("edMel").value, key), b = JP.parse($("edAcc").value, key);
  const msg = $("edMsg");
  const errs = a.errors.map(e => "旋律：" + e).concat(b.errors.map(e => "伴奏：" + e));
  if (errs.length){ msg.className = "ed-msg err"; msg.textContent = errs.slice(0, 3).join("；"); return false; }
  if (!a.notes.length){ msg.className = "ed-msg err"; msg.textContent = "旋律里还没有音。"; return false; }
  const ms = a.notes.map(n => n.m);
  msg.className = "ed-msg";
  msg.textContent = "✓ " + a.notes.length + " 个音，约 " + Math.ceil(a.beats / bpb) + " 小节，最低 " + noteNm(Math.min(...ms)) +
    "、最高 " + noteNm(Math.max(...ms)) + (b.notes.length ? "；伴奏 " + b.notes.length + " 个音" : "") +
    (b.notes.length && Math.abs(a.beats - b.beats) > 0.01 ? "（注意：旋律 " + a.beats + " 拍，伴奏 " + b.beats + " 拍，长度不一样）" : "");
  return true;
}
function formSong(){
  return {
    id: edId || ("u" + Date.now().toString(36)),
    name: $("edName").value.trim() || "未命名",
    key: $("edKey").value, meter: $("edMeter").value,
    bpm: Math.max(30, Math.min(240, +$("edBpm").value || 90)),
    mel: $("edMel").value, acc: $("edAcc").value,
  };
}
function stopListen(){ if (listenStop){ listenStop(); listenStop = null; } $("edListen").textContent = "试听"; }
$("edListen").addEventListener("click", () => {
  if (listenStop){ stopListen(); return; }
  if (!validate()) return;
  const ac = AU.init(), sg = formSong(), spb = 60 / sg.bpm, t0 = ac.currentTime + 0.1;
  const hs = [];
  for (const n of JP.parse(sg.mel, sg.key).notes){ const h = AU.strike(n.m, .75, t0 + n.b * spb); h.release(t0 + (n.b + n.d * .95) * spb); hs.push(h); }
  for (const n of JP.parse(sg.acc, sg.key).notes){ const h = AU.strike(n.m, .4, t0 + n.b * spb); h.release(t0 + (n.b + n.d) * spb); hs.push(h); }
  const tm = setTimeout(stopListen, (JP.parse(sg.mel, sg.key).beats * spb + 0.5) * 1000);
  listenStop = () => { clearTimeout(tm); for (const h of hs) h.release(); };
  $("edListen").textContent = "停止";
});
for (const id of ["edMel", "edAcc", "edKey", "edMeter"]) $(id).addEventListener("input", validate);
$("edSave").addEventListener("click", () => {
  if (!validate()) return;
  const sg = formSong();
  const i = songs.findIndex(s => s.id === sg.id);
  if (i >= 0) songs[i] = sg; else songs.push(sg);
  saveSongs(); S.song = sg.id; saveS();
  closeEditor(); loadSong();
});
$("edDel").addEventListener("click", () => {
  if (!edId || !confirm("删除「" + $("edName").value + "」？")) return;
  songs = songs.filter(s => s.id !== edId);
  if (!songs.length) songs = structuredClone(BUILTIN_SONGS);
  saveSongs(); S.song = songs[0].id; saveS();
  closeEditor(); loadSong();
});
$("edReset").addEventListener("click", () => {
  const b = BUILTIN_SONGS.find(x => x.id === edId); if (!b) return;
  openEditor(structuredClone(b)); edId = b.id;
});
$("edClose").addEventListener("click", closeEditor);
$("editor").addEventListener("pointerdown", e => { if (e.target === $("editor")) closeEditor(); });
$("editBtn").addEventListener("click", () => { $("setPop").hidden = true; openEditor(curSong()); });
$("newSongBtn").addEventListener("click", () => { $("songPop").hidden = true; openEditor(null); });
$("edExport").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(songs, null, 2)], {type: "application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "极夜钢琴-曲谱.json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$("edImport").addEventListener("click", () => $("edFile").click());
$("edFile").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const arr = JSON.parse(await f.text());
    const list = Array.isArray(arr) ? arr : [arr];
    let n = 0;
    for (const s of list){
      if (!s || typeof s.mel !== "string") continue;
      const sg = {id: s.id || ("u" + Date.now().toString(36) + n), name: s.name || "未命名", key: s.key || "C",
                  meter: s.meter || "4/4", bpm: +s.bpm || 90, mel: s.mel, acc: s.acc || ""};
      const i = songs.findIndex(x => x.id === sg.id);
      if (i >= 0) songs[i] = sg; else songs.push(sg);
      n++;
    }
    saveSongs();
    $("edMsg").className = "ed-msg"; $("edMsg").textContent = "✓ 导入了 " + n + " 首。";
  } catch (err){
    $("edMsg").className = "ed-msg err"; $("edMsg").textContent = "这个文件读不了，要用「导出」得到的 .json。";
  }
});

/* ================= 启动 ================= */
const KB_SIZES = [0.18, 0.22, 0.25, 0.29, 0.33];
function applyKbSize(){
  if (!KB_SIZES.includes(S.kbSize)) S.kbSize = 0.25;
  document.documentElement.style.setProperty("--kb-total", Math.round(innerHeight * S.kbSize) + "px");
  $("kbVal").textContent = Math.round(S.kbSize * 100) + "%";
}
function kbStep(d){
  const i = Math.max(0, Math.min(KB_SIZES.length - 1, KB_SIZES.indexOf(S.kbSize) + d));
  S.kbSize = KB_SIZES[i]; saveS(); applyKbSize(); onResize();
}
$("kbDown").addEventListener("click", () => kbStep(-1));
$("kbUp").addEventListener("click", () => kbStep(1));
function renderTilt(){ for (const b of $("tiltSeg").children) b.setAttribute("aria-pressed", String(b.dataset.v === S.tilt)); }
$("tiltSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; S.tilt = b.dataset.v; saveS(); renderTilt(); onResize(); });
$("setBtn").addEventListener("click", e => { e.stopPropagation(); const p = $("setPop"); p.hidden = !p.hidden; });
addEventListener("pointerdown", e => { const p = $("setPop"); if (!p.hidden && !p.contains(e.target) && !$("setBtn").contains(e.target)) p.hidden = true; });
function onResize(){ applyKbSize(); buildKeys(); sizeCanvas(); }
addEventListener("resize", onResize);
applyKbSize();
renderTilt();
fillKeys();
renderLevels();
renderMetro();
$("labelSel").value = S.label;
$("spdVal").textContent = Math.round(S.speed * 100) + "%";
if (!SPEEDS.includes(S.speed)) S.speed = 1;
loadSong();
requestAnimationFrame(frame);
