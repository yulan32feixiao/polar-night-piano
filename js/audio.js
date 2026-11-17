/* 声音：真钢琴采样（Salamander Grand Piano，CC BY 3.0）+ 节拍器。
   采样每 3 个半音一个，其余音按最近的采样变调。拿不到采样时用合成音顶上。 */
(function(){
  const NAMES = ["A1","C2","Ds2","Fs2","A2","C3","Ds3","Fs3","A3","C4","Ds4","Fs4","A4",
                 "C5","Ds5","Fs5","A5","C6","Ds6","Fs6","A6","C7","Ds7","Fs7","A7","C8"];
  const toMidi = n => {
    const r = /^([A-G])(s?)(\d)$/.exec(n);
    return (+r[3] + 1) * 12 + {C:0,D:2,E:4,F:5,G:7,A:9,B:11}[r[1]] + (r[2] ? 1 : 0);
  };
  let ac = null, master = null, verb = null;
  const bufs = new Map(); let keys = [];

  function init(){
    if (ac){ if (ac.state !== "running") ac.resume().catch(() => {}); return ac; }
    try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) {}
    ac = new (window.AudioContext || window.webkitAudioContext)({latencyHint: "interactive"});
    master = ac.createGain(); master.gain.value = 0.9; master.connect(ac.destination);
    /* 小房间混响，噪声生成，不需要外部文件 */
    verb = ac.createConvolver();
    const len = Math.floor(ac.sampleRate * 1.6), ir = ac.createBuffer(2, len, ac.sampleRate);
    for (let c = 0; c < 2; c++){
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    verb.buffer = ir;
    const wet = ac.createGain(); wet.gain.value = 0.16; verb.connect(wet); wet.connect(master);
    load();
    return ac;
  }

  async function load(){
    await Promise.all(NAMES.map(async n => {
      try {
        const r = await fetch("assets/piano/" + n + ".m4a");
        if (!r.ok) return;
        bufs.set(toMidi(n), await ac.decodeAudioData(await r.arrayBuffer()));
      } catch (e) {}
    }));
    keys = [...bufs.keys()].sort((a, b) => a - b);
  }
  const nearest = m => keys.reduce((b, k) => Math.abs(k - m) < Math.abs(b - m) ? k : b, keys[0]);

  /* 按下一个音，返回 {release(when)} —— 按住一直响，松手止音 */
  function strike(m, vel = 0.8, when){
    if (!ac) init();
    const t = Math.max(ac.currentTime, when || 0);
    const g = ac.createGain();
    g.connect(master); g.connect(verb);
    if (keys.length){
      const s = nearest(m), src = ac.createBufferSource();
      src.buffer = bufs.get(s);
      src.playbackRate.value = Math.pow(2, (m - s) / 12);
      g.gain.value = 0.25 + 0.75 * vel;
      src.connect(g); src.start(t);
      let done = false;
      src.onended = () => { done = true; try { g.disconnect(); } catch (e) {} };
      return {release(at){
        if (done) return;
        const w = Math.max(ac.currentTime, at || 0);
        g.gain.setTargetAtTime(0, w, 0.08);
        try { src.stop(w + 0.6); } catch (e) {}
      }};
    }
    /* 合成钢琴（采样还没加载好时） */
    const f = 440 * Math.pow(2, (m - 69) / 12), oscs = [];
    const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = Math.min(12000, f * 8 + 800);
    lp.connect(g);
    for (const [r, a] of [[1, 1], [2, .35], [3, .14], [4, .06]]){
      const o = ac.createOscillator(), og = ac.createGain();
      o.type = r === 1 ? "triangle" : "sine"; o.frequency.value = f * r; og.gain.value = a;
      o.connect(og); og.connect(lp); o.start(t); o.stop(t + 6); oscs.push(o);
    }
    const peak = 0.3 * (0.3 + 0.7 * vel);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.006);
    g.gain.exponentialRampToValueAtTime(peak * 0.3, t + 0.3);
    g.gain.exponentialRampToValueAtTime(1e-4, t + 5);
    let rel = false;
    return {release(at){
      if (rel) return; rel = true;
      const w = Math.max(ac.currentTime, at || 0);
      g.gain.cancelScheduledValues(w); g.gain.setTargetAtTime(0, w, 0.06);
      for (const o of oscs) try { o.stop(w + 0.5); } catch (e) {}
    }};
  }

  /* 节拍器的“嗒”：第一拍高一点 */
  function click(when, accent){
    if (!ac) init();
    const t = Math.max(ac.currentTime, when);
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = "sine"; o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(accent ? 0.42 : 0.26, t + 0.002);
    g.gain.exponentialRampToValueAtTime(1e-4, t + 0.06);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.08);
  }

  window.AU = {init, strike, click, get ctx(){ return ac; }, get ready(){ return keys.length > 0; }};
})();
