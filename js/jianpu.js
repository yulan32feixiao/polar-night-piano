/* 简谱文本 → 音符，以及“难度 → 琴键范围”的换算。 */
(function(){
  const DEG = [null, 0, 2, 4, 5, 7, 9, 11];             /* 1..7 → 半音 */
  const KEYS = [                                         /* 调 → 相对 C 的半音 */
    ["C",0],["#C",1],["D",2],["bE",3],["E",4],["F",5],["#F",6],["G",7],["bA",8],["A",9],["bB",10],["B",11]
  ];
  const keyOffset = k => (KEYS.find(x => x[0] === k) || KEYS[0])[1];

  /* 拍号 → 每小节几拍（拍的单位就是分母那个音符） */
  const beatsPerBar = meter => { const n = parseInt(String(meter).split("/")[0], 10); return n > 0 ? n : 4; };

  /* 解析：返回 {notes:[{b, d, m}], beats, errors:[文字]}
     b = 第几拍开始，d = 几拍，m = MIDI 音高（60 = 中央 C） */
  function parse(text, key){
    const base = 60 + keyOffset(key || "C");
    const notes = [], errors = [];
    let beat = 0, last = null;                           /* last = 上一个事件，"-" 往它身上加拍 */
    const toks = String(text || "").replace(/[｜]/g, "|").split(/\s+/).filter(Boolean);
    toks.forEach((tok, i) => {
      if (/^\|+$/.test(tok)) return;
      if (/^-+$/.test(tok)){                             /* "-" 或 "--" */
        const n = tok.length;
        if (last) for (const x of last) x.d += n;
        beat += n;
        return;
      }
      /* 整个 token 末尾的 _ 和 . 决定时值；和弦用 + 连 */
      const m = /^(.*?)([_.]*)$/.exec(tok);
      const body = m[1], suf = m[2];
      const halves = (suf.match(/_/g) || []).length, dot = suf.includes(".");
      const dur = Math.pow(0.5, halves) * (dot ? 1.5 : 1);
      const parts = body.split("+");
      const evs = [];
      let bad = false;
      for (const p of parts){
        const q = /^([#b]?)([0-7])([',]*)$/.exec(p);
        if (!q){ bad = true; break; }
        const d = +q[2];
        if (d === 0) continue;                           /* 休止 */
        const up = (q[3].match(/'/g) || []).length, down = (q[3].match(/,/g) || []).length;
        const acc = q[1] === "#" ? 1 : q[1] === "b" ? -1 : 0;
        evs.push({b: beat, d: dur, m: base + DEG[d] + acc + 12 * (up - down)});
      }
      if (bad || !body){ errors.push("第 " + (i + 1) + " 个记号「" + tok + "」看不懂"); return; }
      for (const e of evs) notes.push(e);
      last = evs.length ? evs : [{d: 0}];                /* 休止后面的 "-" 只延长休止 */
      beat += dur;
    });
    return {notes, beats: beat, errors};
  }

  /* ---------------- 难度 = 琴键数量 ---------------- */
  const LEVELS = [
    {id: "l1", name: "入门", keys: 8,  whites: true, span: 12, free: [60, 72]},
    {id: "l2", name: "初级", keys: 13, span: 12, free: [60, 72]},
    {id: "l3", name: "中级", keys: 25, span: 24, free: [48, 72]},
    {id: "l4", name: "高级", keys: 37, span: 36, free: [48, 84]},
    {id: "l5", name: "全键", keys: 61, span: 60, free: [36, 96], fixed: true},
  ];
  const isBlack = m => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);

  /* 给一串旋律音高选琴键范围，返回 {lo, hi, shift, map(m)}
     shift = 整体移调（只有“入门”纯白键会用），map = 把音放进范围 */
  function fit(mels, level){
    const L = LEVELS.find(x => x.id === level) || LEVELS[1];
    let shift = 0;
    if (L.whites && mels.length){
      /* 换到黑键最少的调；平手时移得越少越好 */
      let best = Infinity;
      for (let t = -6; t <= 5; t++){
        const cost = mels.filter(m => isBlack(m + t)).length * 10 + Math.abs(t);
        if (cost < best){ best = cost; shift = t; }
      }
    }
    const fold = (m, lo, hi) => { while (m < lo) m += 12; while (m > hi) m -= 12; return m; };
    const snap = m => (L.whites && isBlack(m)) ? m - 1 : m;
    const pitches = mels.map(m => snap(m + shift));

    let lo = L.free[0], hi = L.free[1];
    if (!L.fixed && pitches.length){
      const mid = pitches.reduce((a, b) => a + b, 0) / pitches.length;
      let bestScore = -Infinity;
      for (let c = 36; c <= 84; c++){
        if (isBlack(c)) continue;
        const h = c + L.span;
        const inside = pitches.filter(m => m >= c && m <= h).length;
        const score = inside * 100 - Math.abs(mid - (c + h) / 2) - (c % 12 === 0 ? 0 : 6)  /* 能从 C 开始就从 C 开始，像真钢琴 */;
        if (score > bestScore){ bestScore = score; lo = c; hi = h; }
      }
    }
    return {
      lo, hi, shift, whites: !!L.whites,
      map: m => fold(snap(m + shift), lo, hi)
    };
  }

  window.JP = {parse, fit, LEVELS, KEYS, keyOffset, beatsPerBar, isBlack};
})();
