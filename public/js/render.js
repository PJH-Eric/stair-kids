/* ===== render.js — 繪圖：Canvas 畫場景與階梯，SVG 畫小朋友與 UI =====
 * 規劃書 §7／§8。全手繪向量，沒有任何 emoji 文字美術。
 *
 * 座標換算：世界 x ∈ [0,12]、depth 往下為正；畫面上緣永遠是 cameraTop。
 */
(function (root) {
  'use strict';

  let uid = 0;
  const C_FLASH = 0.22;                 /* 刺階閃白光的長度（秒），要跟 rules.js 的 step.flash 一致 */
  /* 角色尺寸一律問規則核心，不在這裡另抄一份（抄了就會漂）。
   * SVG 的本地座標是 100 × 160，剛好是 1 : 1.6，所以只要 PLAYER_H = PLAYER_W × 1.6
   * 就可以用單一縮放，不會把小朋友壓扁。 */
  const fieldWidth = () => (root.Rules ? root.Rules.C.FIELD_W : 14);
  const playerW = () => (root.Rules ? root.Rules.C.PLAYER_W : 1.25);
  const playerH = () => (root.Rules ? root.Rules.C.PLAYER_H : 2.0);
  const VOID_UNITS = 2.2;               /* 死亡線下面留幾格的深淵：
                                         * 看得到「掉下去就沒了」，又不會浪費半個螢幕。 */
  const CEIL_UNITS = 1.1;               /* 畫面最上面留給天花板的高度（格）。
                                         * 天花板的底座本來畫在 cameraTop 以上，也就是畫面外，
                                         * 結果只剩白色的刺露在淺色背景上，等於看不見。
                                         * 留出這段空間之後底座才看得到，刺也才有厚度可以畫。 */

  /* ================================================================
   *  一、手繪小朋友（SVG）
   *  頭＋身體＋雙手＋雙腳，漸層做立體感，不是圓球加臉。
   *  回傳的內容含具名子群組，poseKid() 只改 transform 就能換姿勢。
   * ================================================================ */

  function hairPath(style, c) {
    switch (style) {
      case 'bob':      /* 妹妹頭 */
        return '<path d="M20 40q0-28 30-28t30 28q0 6-2 10 -6-14-28-14t-28 14q-2-4-2-10z" fill="url(#' + c + '-hair)"/>' +
               '<path d="M18 40q2 16 4 24 -8-6-8-18 0-4 4-6z" fill="url(#' + c + '-hair)"/>' +
               '<path d="M82 40q-2 16-4 24 8-6 8-18 0-4-4-6z" fill="url(#' + c + '-hair)"/>';
      case 'twin':     /* 雙馬尾 */
        return '<path d="M20 40q0-28 30-28t30 28q0 5-2 9 -8-13-28-13t-28 13q-2-4-2-9z" fill="url(#' + c + '-hair)"/>' +
               '<ellipse cx="12" cy="52" rx="9" ry="16" fill="url(#' + c + '-hair)"/>' +
               '<ellipse cx="88" cy="52" rx="9" ry="16" fill="url(#' + c + '-hair)"/>';
      case 'short':
        return '<path d="M20 42q0-30 30-30t30 30q0 4-2 7 -4-16-28-16-16 0-22 10 -3 3-6 6 -2-3-2-7z" fill="url(#' + c + '-hair)"/>';
      case 'curly':
        return '<path d="M22 40q0-28 28-28t28 28q0 4-1 7 -5-13-27-13t-27 13q-1-3-1-7z" fill="url(#' + c + '-hair)"/>' +
               '<circle cx="26" cy="24" r="9" fill="url(#' + c + '-hair)"/>' +
               '<circle cx="44" cy="16" r="10" fill="url(#' + c + '-hair)"/>' +
               '<circle cx="62" cy="17" r="9" fill="url(#' + c + '-hair)"/>' +
               '<circle cx="76" cy="26" r="8" fill="url(#' + c + '-hair)"/>';
      case 'pony':
        return '<path d="M20 41q0-29 30-29t30 29q0 5-2 8 -6-14-28-14t-28 14q-2-3-2-8z" fill="url(#' + c + '-hair)"/>' +
               '<path d="M78 34q14 4 16 22 2 18-8 26 6-18-2-30 -4-8-10-10z" fill="url(#' + c + '-hair)"/>';
      case 'buzz':
        return '<path d="M22 42q0-30 28-30t28 30q0 3-1 5 -6-11-27-11t-27 11q-1-2-1-5z" fill="url(#' + c + '-hair)" opacity=".92"/>';
      case 'wave':
        return '<path d="M20 42q0-30 30-30t30 30q0 4-2 7 -3-8-9-6 -5 2-9-2 -5-5-11-1 -6 4-12 0 -5-3-9 2 -4 4-6 6 -2-3-2-7z" fill="url(#' + c + '-hair)"/>';
      case 'bun':
      default:
        return '<path d="M20 41q0-29 30-29t30 29q0 5-2 8 -6-14-28-14t-28 14q-2-3-2-8z" fill="url(#' + c + '-hair)"/>' +
               '<circle cx="50" cy="8" r="13" fill="url(#' + c + '-hair)"/>';
    }
  }

  function topPath(style, c, accent) {
    /* 身體：肩到腰的圓角形，漸層做立體 */
    const base = '<path d="M28 70q0-8 8-10 6-2 14-2t14 2q8 2 8 10v40q0 8-8 9 -6 1-14 1t-14-1q-8-1-8-9z" fill="url(#' + c + '-shirt)"/>';
    let extra = '';
    if (style === 'dress') {
      extra = '<path d="M26 104q-4 14-6 20 10 5 30 5t30-5q-2-6-6-20z" fill="url(#' + c + '-shirt)"/>' +
              '<path d="M20 124q12 5 30 5t30-5q1 4 1 6 -13 6-31 6t-31-6q0-2 1-6z" fill="' + accent + '" opacity=".55"/>';
    } else if (style === 'overall') {
      extra = '<path d="M36 68v16h6V70zm22 0v14h6V68z" fill="url(#' + c + '-pants)"/>' +
              '<path d="M30 96h40v18q0 6-6 7 -7 1-14 1t-14-1q-6-1-6-7z" fill="url(#' + c + '-pants)"/>';
    } else if (style === 'hoodie') {
      extra = '<path d="M30 68q8 12 20 12t20-12q4 2 4 6 -8 12-24 12t-24-12q0-4 4-6z" fill="url(#' + c + '-shirt)" opacity=".75"/>' +
              '<path d="M48 84h4v18h-4z" fill="' + accent + '" opacity=".6"/>';
    } else if (style === 'stripe') {
      extra = '<g opacity=".45" fill="' + accent + '">' +
              '<rect x="28" y="78" width="44" height="6" rx="3"/>' +
              '<rect x="28" y="92" width="44" height="6" rx="3"/>' +
              '<rect x="28" y="106" width="44" height="6" rx="3"/></g>';
    }
    return base + extra;
  }

  /**
   * 建一隻小朋友的 SVG 內容（字串）。本地座標 100 × 160 ＝ 1.0 × 1.6 格。
   * @param {object} char themes/characters.js 的一筆資料
   * @param {object} opt  { id, ring: 玩家色外框, halo: 腳下光環 }
   */
  function buildKid(char, opt) {
    opt = opt || {};
    const c = opt.id || ('k' + (++uid));

    const defs =
      '<defs>' +
      '<radialGradient id="' + c + '-skin" cx="38%" cy="30%" r="75%">' +
        '<stop offset="0" stop-color="#fff" stop-opacity=".55"/>' +
        '<stop offset="45%" stop-color="' + char.skin + '"/>' +
        '<stop offset="100%" stop-color="' + char.skinDark + '"/></radialGradient>' +
      '<linearGradient id="' + c + '-hair" x1="0" y1="0" x2="0.3" y2="1">' +
        '<stop offset="0" stop-color="' + char.hairColor + '"/>' +
        '<stop offset="100%" stop-color="' + char.hairDark + '"/></linearGradient>' +
      '<linearGradient id="' + c + '-shirt" x1="0.1" y1="0" x2="0.9" y2="1">' +
        '<stop offset="0" stop-color="' + char.shirt + '"/>' +
        '<stop offset="100%" stop-color="' + char.shirtDark + '"/></linearGradient>' +
      '<linearGradient id="' + c + '-pants" x1="0.1" y1="0" x2="0.9" y2="1">' +
        '<stop offset="0" stop-color="' + char.pants + '"/>' +
        '<stop offset="100%" stop-color="' + char.pantsDark + '"/></linearGradient>' +
      '<linearGradient id="' + c + '-limb" x1="0" y1="0" x2="1" y2="0.4">' +
        '<stop offset="0" stop-color="' + char.skin + '"/>' +
        '<stop offset="100%" stop-color="' + char.skinDark + '"/></linearGradient>' +
      '</defs>';

    /* 手：上臂圓角柱 ＋ 手掌小球（旋轉原點在肩膀）。
     * 肩膀放在身體外緣，走路擺手才看得出來，不會整條藏在身體後面。 */
    const arm =
      '<path d="M0 0q6 0 7 6v20q0 7-7 7t-7-7V6q1-6 7-6z" fill="url(#' + c + '-limb)"/>' +
      '<circle cx="0" cy="30" r="7.5" fill="url(#' + c + '-skin)"/>';
    /* 腳：褲管 ＋ 鞋子（旋轉原點在髖部） */
    const leg =
      '<path d="M0 0q7 0 8 7v22q0 7-8 7t-8-7V7q1-7 8-7z" fill="url(#' + c + '-pants)"/>' +
      '<path d="M-9 30h18q3 0 3 4v4q0 4-4 4h-16q-4 0-4-4v-4q0-4 3-4z" fill="' + char.shoe + '"/>';

    /* 眼睛拆成遠側／近側兩組，轉成四分之三側臉時可以各自縮放 */
    const face =
      '<g class="k-eyes">' +
        '<g class="k-eye-far">' +
          '<ellipse cx="38" cy="42" rx="5" ry="6.5" fill="#2C2422"/>' +
          '<circle cx="36.4" cy="39.6" r="1.9" fill="#fff"/>' +
        '</g>' +
        '<g class="k-eye-near">' +
          '<ellipse cx="62" cy="42" rx="5" ry="6.5" fill="#2C2422"/>' +
          '<circle cx="60.4" cy="39.6" r="1.9" fill="#fff"/>' +
        '</g>' +
      '</g>' +
      '<g class="k-eyes-shut" opacity="0">' +
        '<path d="M32 43q6 5 12 0" stroke="#2C2422" stroke-width="3" fill="none" stroke-linecap="round"/>' +
        '<path d="M56 43q6 5 12 0" stroke="#2C2422" stroke-width="3" fill="none" stroke-linecap="round"/>' +
      '</g>' +
      '<g class="k-eyes-x" opacity="0">' +
        '<path d="M33 37l10 10M43 37l-10 10" stroke="#2C2422" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M57 37l10 10M67 37l-10 10" stroke="#2C2422" stroke-width="3" stroke-linecap="round"/>' +
      '</g>' +
      '<ellipse class="k-cheek-far" cx="28" cy="50" rx="6" ry="4" fill="#FF9BB0" opacity=".55"/>' +
      '<ellipse class="k-cheek-near" cx="72" cy="50" rx="6" ry="4" fill="#FF9BB0" opacity=".55"/>' +
      '<path class="k-mouth" d="M44 53q6 6 12 0" stroke="#B4574F" stroke-width="3" fill="none" stroke-linecap="round"/>';

    const halo = opt.halo
      ? '<ellipse class="k-halo" cx="50" cy="156" rx="30" ry="8" fill="none" stroke="' + opt.halo + '" stroke-width="4" opacity=".8"/>'
      : '';
    const ringLayer = opt.ring
      ? '<circle class="k-ring" cx="50" cy="40" r="33" fill="none" stroke="' + opt.ring + '" stroke-width="4" opacity=".9"/>'
      : '';

    const body =
      '<ellipse class="k-shadow" cx="50" cy="157" rx="26" ry="5" fill="#000" opacity=".16"/>' +
      '<g class="k-figure">' +
        '<g class="k-armR" transform="translate(76,74)">' + arm + '</g>' +
        '<g class="k-legR" transform="translate(61,114)">' + leg + '</g>' +
        '<g class="k-legL" transform="translate(39,114)">' + leg + '</g>' +
        '<g class="k-body">' + topPath(char.top, c, char.accent) + '</g>' +
        '<g class="k-armL" transform="translate(24,74)">' + arm + '</g>' +
        '<g class="k-head">' +
          '<path d="M44 62h12v10h-12z" fill="' + char.skinDark + '"/>' +
          '<circle cx="50" cy="40" r="30" fill="url(#' + c + '-skin)"/>' +
          '<g class="k-hair">' + hairPath(char.hair, c) + '</g>' +
          '<g class="k-face">' + face + '</g>' +
          /* 鼻尖：從臉的輪廓凸出來，是「有在轉頭」最關鍵的一筆。所以要畫在最上面，
           * 排在頭髮後面會被瀏海蓋掉。也不能用 -skin 漸層 —— 漸層以「自己的
           * bounding box」為單位，這麼小的零件會整片變成最淺的那一端，等於看不見。 */
          '<g class="k-nose" opacity="0">' +
            '<path d="M76 41q8 3.5 8 7.5 0 4-8 5z" fill="' + char.skin + '"/>' +
            '<path d="M76 48.5q8 0 8 .5 0 4-8 5z" fill="' + char.skinDark + '" opacity=".4"/>' +
          '</g>' +
        '</g>' +
      '</g>';

    return defs + halo + body + ringLayer;
  }

  /**
   * 換姿勢（六組：走路、下墜、落地／站立、踩刺、被頂、暈眩）。
   * 只改 transform 與少數 opacity，不重建 DOM。
   */
  function poseKid(el, pose, phase, opt) {
    if (!el) return;
    opt = opt || {};
    const q = sel => el.querySelector(sel);
    const armL = q('.k-armL'), armR = q('.k-armR');
    const legL = q('.k-legL'), legR = q('.k-legR');
    const fig = q('.k-figure'), head = q('.k-head'), faceG = q('.k-face');
    const eyes = q('.k-eyes'), shut = q('.k-eyes-shut'), ex = q('.k-eyes-x');
    const eyeFar = q('.k-eye-far'), eyeNear = q('.k-eye-near');
    const nose = q('.k-nose'), hair = q('.k-hair'), bodyG = q('.k-body');
    const cheekFar = q('.k-cheek-far'), cheekNear = q('.k-cheek-near');
    const mouth = q('.k-mouth');
    if (!armL || !legL || !fig) return;

    let aL = 8, aR = -8, lL = 0, lR = 0, tilt = 0, bob = 0, sy = 1;
    let eye = 'open';
    if (pose === 'walk') {
      const s = Math.sin(phase * 9);
      lL = s * 26; lR = -s * 26;
      aL = -s * 30 + 6; aR = s * 30 - 6;
      bob = Math.abs(s) * -2;
    } else if (pose === 'fall') {
      aL = -120; aR = 120; lL = -12; lR = 14;
      bob = Math.sin(phase * 14) * 1.5;
    } else if (pose === 'spring') {
      aL = -160; aR = 160; lL = 18; lR = -18; sy = 1.06;
    } else if (pose === 'land') {
      aL = -30; aR = 30; lL = -6; lR = 6; sy = 0.94;
    } else if (pose === 'ceiling') {
      aL = -170; aR = 170; sy = 0.9; lL = 6; lR = -6; eye = 'shut';
    } else if (pose === 'stun') {
      tilt = 16; aL = -40; aR = 40; lL = -18; lR = 20; eye = 'x';
    } else {
      bob = Math.sin(phase * 2.2) * 1.5;
      eye = (phase % 4.2) < 0.16 ? 'shut' : 'open';
    }

    /* ---- 四分之三側臉 ----
     * 一律「照著右邊」畫，要面向左邊就把整個角色水平鏡射（下面 fig 的 scale）。
     * turn 是 0～1 的轉頭程度，讓正面↔側面之間有一小段過渡，快速左右點按才不會抽動。
     */
    const turn = Math.max(0, Math.min(1, opt.turn == null ? (opt.face ? 1 : 0) : opt.turn));
    if (turn > 0) {
      /* 手臂跟著轉：近的那隻往前擺、遠的那隻收到身體後面 */
      aL -= turn * 18;
      aR -= turn * 18;
    }

    /* 近側的手往前挪到身體外面，遠側的手縮到身體後面（幾乎看不到） */
    armL.setAttribute('transform', 'translate(' + (24 + turn * 9).toFixed(1) + ',' +
      (74 + turn * 2).toFixed(1) + ') rotate(' + aL.toFixed(1) + ')');
    armR.setAttribute('transform', 'translate(' + (76 - turn * 18).toFixed(1) + ',' +
      (74 + turn * 3).toFixed(1) + ') rotate(' + aR.toFixed(1) + ') scale(' + (1 - turn * 0.2).toFixed(3) + ')');
    /* 兩隻腳靠近，前後站而不是左右站 */
    legL.setAttribute('transform', 'translate(' + (39 + turn * 7).toFixed(1) + ',114) rotate(' + lL.toFixed(1) + ')');
    legR.setAttribute('transform', 'translate(' + (61 - turn * 5).toFixed(1) + ',' +
      (114 + turn * 1.5).toFixed(1) + ') rotate(' + lR.toFixed(1) + ') scale(' + (1 - turn * 0.12).toFixed(3) + ')');
    /* 身體壓窄：轉過去之後看到的是比較窄的那一面 */
    if (bodyG) {
      bodyG.setAttribute('transform',
        'translate(' + (50 + turn * 3).toFixed(2) + ',92) scale(' + (1 - turn * 0.14).toFixed(3) +
        ',1) translate(-50,-92)');
    }
    fig.setAttribute('transform',
      'translate(50,' + (150 + bob).toFixed(1) + ') rotate(' + tilt.toFixed(1) + ') scale(' +
      (opt.face === -1 ? -1 : 1) + ',' + sy.toFixed(3) + ') translate(-50,-150)');
    /* 整顆頭往前傾，並壓窄 —— 轉過去之後看到的臉本來就比較窄 */
    if (head) {
      head.setAttribute('transform',
        'rotate(' + (tilt * 0.4).toFixed(1) + ' 50 40) translate(' + (turn * 4).toFixed(2) + ',0) ' +
        'translate(50,44) scale(' + (1 - turn * 0.06).toFixed(3) + ',1) translate(-50,-44)');
    }
    /* 頭髮也跟著往前挪一點、但比五官慢，兩者的相對位移就是「轉頭」；
     * 順便讓後腦那一側多露出來一些。 */
    if (hair) {
      hair.setAttribute('transform',
        'translate(' + (50 + turn * 2.5).toFixed(2) + ',40) scale(' + (1 + turn * 0.03).toFixed(3) + ',1) translate(-50,-40)');
    }
    if (faceG) {
      /* 五官整組往前臉方向偏，並壓窄，做出臉轉過去的透視。
       * 位移刻意不能太大：再往外就會壓到瀏海與臉的輪廓外面去。 */
      faceG.setAttribute('transform',
        'translate(' + (50 + turn * 7).toFixed(2) + ',40) scale(' + (1 - turn * 0.18).toFixed(3) + ',1) translate(-50,-40)');
    }
    /* 遠側的眼睛縮小、近側的放大，是側臉最好認的線索 */
    if (eyeFar) {
      eyeFar.setAttribute('transform',
        'translate(38,42) scale(' + (1 - turn * 0.5).toFixed(3) + ',' + (1 - turn * 0.1).toFixed(3) + ') translate(-38,-42)');
    }
    if (eyeNear) {
      eyeNear.setAttribute('transform',
        'translate(62,42) scale(' + (1 + turn * 0.12).toFixed(3) + ',' + (1 + turn * 0.06).toFixed(3) + ') translate(-62,-42)');
    }
    /* 遠側的臉頰縮小，不然轉過去會滑到臉外面變成一塊浮在頭髮上的粉紅色 */
    if (cheekFar) {
      cheekFar.setAttribute('transform',
        'translate(28,50) scale(' + (1 - turn * 0.55).toFixed(3) + ') translate(-28,-50)');
    }
    if (cheekNear) {
      cheekNear.setAttribute('transform',
        'translate(' + (72 - turn * 4).toFixed(2) + ',50) scale(' + (1 - turn * 0.15).toFixed(3) + ') translate(-72,-50)');
    }
    if (nose) nose.setAttribute('opacity', turn.toFixed(3));
    if (eyes) eyes.setAttribute('opacity', eye === 'open' ? '1' : '0');
    if (shut) shut.setAttribute('opacity', eye === 'shut' ? '1' : '0');
    if (ex) ex.setAttribute('opacity', eye === 'x' ? '1' : '0');
    if (mouth) {
      const d = eye === 'x' ? 'M44 56q6-6 12 0'
        : (pose === 'fall' || pose === 'spring') ? 'M45 52q5 8 10 0'
        : 'M44 53q6 6 12 0';
      mouth.setAttribute('d', d);
      /* 側身時嘴巴縮短，看起來才像轉到側面去 */
      mouth.setAttribute('transform',
        'translate(50,53) scale(' + (1 - turn * 0.28).toFixed(3) + ',1) translate(-50,-53)');
    }
  }

  /** 大頭貼（首頁、選角、結算用）：裁到頭與肩，尺寸小也看得清楚 */
  function kidAvatarSvg(char, size, ring) {
    const id = 'av' + (++uid);
    return '<svg class="kid-avatar" viewBox="10 2 80 80" width="' + size + '" height="' + size +
      '" role="img" aria-label="' + char.name + '">' + buildKid(char, { id: id, ring: ring }) + '</svg>';
  }
  /** 全身像 */
  function kidFullSvg(char, size, ring) {
    const id = 'fu' + (++uid);
    return '<svg class="kid-full" viewBox="0 0 100 166" width="' + Math.round(size * 100 / 166) +
      '" height="' + size + '" role="img" aria-label="' + char.name + '">' +
      buildKid(char, { id: id, ring: ring }) + '</svg>';
  }

  /* ================================================================
   *  二、場景與階梯（Canvas）
   * ================================================================ */

  function create(canvas, actorSvg) {
    const ctx = canvas.getContext('2d');
    const view = { scale: 30, offX: 0, offY: 0, w: 360, h: 540, viewH: 18, fieldBottom: 540, dpr: 1 };
    let shake = 0;
    let particles = [];
    const opts = { reduceMotion: false, colorAssist: false, depthGuide: false, viewH: 18 };
    const actors = new Map();     /* playerId → { g, inner, label } */
    const NS = 'http://www.w3.org/2000/svg';

    function resize() {
      const box = canvas.getBoundingClientRect();
      const dpr = Math.min(2, root.devicePixelRatio || 1);
      view.w = Math.max(120, box.width);
      view.h = Math.max(120, box.height);
      view.dpr = dpr;
      canvas.width = Math.round(view.w * dpr);
      canvas.height = Math.round(view.h * dpr);
      view.viewH = opts.viewH || 18;
      /* 垂直方向要放得下「天花板 ＋ 可見高度」 */
      /* 場地寬幾格一律問規則核心（不要在這裡抄一份）。
       * 高度方向要多留 CEIL_UNITS 給天花板；取兩者的最小值，畫面才不會被裁掉 ——
       * 「掉出畫面下緣就摔死」那條線一定要看得到，不然規則會變成看不見的陷阱。 */
      const fieldW = fieldWidth();
      view.scale = Math.min(view.w / fieldW, view.h / (view.viewH + CEIL_UNITS));
      view.offX = (view.w - fieldW * view.scale) / 2;
      view.offY = CEIL_UNITS * view.scale;              /* cameraTop 對到的畫面 y */
      view.fieldBottom = view.offY + view.viewH * view.scale;
      view.fieldPx = fieldW * view.scale;
      /* 寬螢幕上高度才是瓶頸：場地寬度已經被視窗高度綁死，舞台再寬也只是多出兩片牆。
       * 所以回報一個「舞台最多需要多寬」，讓 app.js 把整組面板收到這個寬度，
       * 牆就會維持一條窄邊，可玩區域佔的比例自然拉高。 */
      const wall = Math.max(24, Math.min(72, view.scale * 0.5));
      view.wantStageW = Math.ceil(view.fieldPx + wall * 2);
      /* 反過來的情況：視窗比可玩區域「高」很多（手機直向就是），
       * 死亡線以下會露出一大片深淵，等於整個下半螢幕都是死掉的空間。
       * 所以也回報「舞台最多需要多高」＝天花板 ＋ 可見高度 ＋ 一小段深淵，
       * 多出來的高度讓 app.js 收掉（直向剛好留給下面的方向鍵）。 */
      view.wantStageH = Math.ceil((view.viewH + CEIL_UNITS + VOID_UNITS) * view.scale);
      if (actorSvg) actorSvg.setAttribute('viewBox', '0 0 ' + view.w.toFixed(1) + ' ' + view.h.toFixed(1));
    }

    const px = x => view.offX + x * view.scale;
    const py = (y, camTop) => view.offY + (y - camTop) * view.scale;

    function setOptions(next) {
      Object.assign(opts, next || {});
      resize();
    }

    function roundRect(x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
    function arrow(x, y, len, size) {
      ctx.beginPath();
      ctx.moveTo(x - len, y - size / 2);
      ctx.lineTo(x - len, y + size / 2);
      ctx.lineTo(x + len, y);
      ctx.closePath();
      ctx.fill();
    }

    /* ---------- 背景 ---------- */

    function drawDeco(scene, x, y, dir) {
      const col = scene.decoColors;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(dir, 1);
      const k = scene.deco;
      if (k === 'blocks') {
        for (let i = 0; i < 3; i++) {
          ctx.fillStyle = col[i % col.length];
          ctx.fillRect(-14 + i * 4, -i * 22, 26, 20);
        }
      } else if (k === 'trees') {
        ctx.fillStyle = '#8A5C33'; ctx.fillRect(-4, 0, 8, 40);
        ctx.fillStyle = col[0]; ctx.beginPath(); ctx.arc(0, -8, 24, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = col[1]; ctx.beginPath(); ctx.arc(-12, 2, 15, 0, Math.PI * 2); ctx.fill();
      } else if (k === 'shells') {
        ctx.fillStyle = col[0];
        ctx.beginPath(); ctx.arc(0, 0, 18, Math.PI, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 2;
        for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(i * 8, -16); ctx.stroke(); }
      } else if (k === 'roots') {
        ctx.strokeStyle = '#7A5433'; ctx.lineWidth = 9; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-16, 30); ctx.quadraticCurveTo(6, 4, -4, -26); ctx.stroke();
        ctx.fillStyle = col[0];
        ctx.beginPath(); ctx.ellipse(12, 20, 13, 8, 0, Math.PI, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#F6EEDC'; ctx.fillRect(9, 20, 6, 12);
      } else if (k === 'candy') {
        ctx.strokeStyle = '#FFF6FA'; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(0, 34); ctx.lineTo(0, 4); ctx.stroke();
        for (let i = 3; i >= 0; i--) {
          ctx.beginPath(); ctx.arc(0, 0, 6 + i * 5, 0, Math.PI * 2);
          ctx.strokeStyle = col[i % col.length]; ctx.lineWidth = 5; ctx.stroke();
        }
      } else {
        ctx.fillStyle = col[3];
        for (let i = 0; i < 6; i++) {
          const a = i * 1.7, r = 10 + i * 6;
          ctx.globalAlpha = 0.9 - i * 0.12;
          ctx.beginPath(); ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 2.4, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = col[0]; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, 0, 20, 0.3, 2.6); ctx.stroke();
      }
      ctx.restore();
    }

    function drawBackground(scene, camTop) {
      const fieldW = fieldWidth();
      const g = ctx.createLinearGradient(0, 0, 0, view.h);
      g.addColorStop(0, scene.sky[0]);
      g.addColorStop(1, scene.sky[1]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, view.w, view.h);

      /* 遠景視差：畫在場地範圍內（畫到牆外面會變成兩坨莫名的色塊），
       * 大小與位置用層號揉出來的偽隨機，看起來才不會像複製貼上。 */
      const span = 190;
      const drift = ((camTop * view.scale * 0.18) % span + span) % span;
      const wobble = n => (Math.sin(n * 12.9898) * 43758.5453) % 1;
      ctx.save();
      ctx.globalAlpha = 0.32;
      ctx.fillStyle = scene.far;
      const rows = Math.ceil(view.h / span) + 2;
      const base = Math.floor(camTop * view.scale / span);
      for (let i = -1; i < rows; i++) {
        const n = base + i;
        const yy = i * span - drift;
        const rx = 54 + Math.abs(wobble(n)) * 46;
        /* 位置用場地寬的比例算，不要寫死格數 —— 場地從 12 格放寬到 16 格之後，
         * 寫死的座標會讓所有裝飾都擠在左邊，右邊空一大塊（Eric 就是看到這個）。 */
        const cx = px(fieldW * 0.115 + Math.abs(wobble(n + 0.5)) * fieldW * 0.77);
        ctx.beginPath(); ctx.ellipse(cx, yy, rx, rx * 0.36, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();

      /* 中景裝飾：每套世界不同（純向量，沒有文字美術） */
      const span2 = 210;
      const drift2 = ((camTop * view.scale * 0.34) % span2 + span2) % span2;
      const jitter = n => ((Math.sin(n * 78.233) * 12345.678) % 1);
      const base2 = Math.floor(camTop * view.scale / span2);
      ctx.save();
      ctx.globalAlpha = 0.42;
      for (let i = -1; i < Math.ceil(view.h / span2) + 2; i++) {
        const n = base2 + i;
        const yy = i * span2 - drift2;
        drawDeco(scene, px(fieldW * 0.055), yy + 30 + Math.abs(jitter(n)) * 60, 1);
        drawDeco(scene, px(fieldW * 0.945), yy + 120 + Math.abs(jitter(n + 3)) * 60, -1);
      }
      ctx.restore();

      /* 左右牆（撞牆停住，不繞回） */
      const wall = ctx.createLinearGradient(0, 0, view.w, 0);
      wall.addColorStop(0, scene.mid);
      wall.addColorStop(0.07, 'rgba(0,0,0,0)');
      wall.addColorStop(0.93, 'rgba(0,0,0,0)');
      wall.addColorStop(1, scene.mid);
      ctx.save();
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = wall;
      ctx.fillRect(0, 0, view.w, view.h);
      ctx.restore();
      /* 場地兩側的留白（桌機寬版才會出現）畫成豎井的牆面。
       * 只壓一層暗色的話會像沒畫完的空地；畫成牆之後整個畫面才讀成「一口往下的井」。 */
      if (view.offX > 2) drawShaftWall(scene, camTop);
    }

    /** 場地外側的牆面：縱向壁板 ＋ 隨鏡頭捲動的橫向接縫 ＋ 靠場地那側的陰影 */
    function drawShaftWall(scene, camTop) {
      const w = view.offX;
      const seam = Math.max(26, view.scale * 0.9);
      const drift = ((camTop * view.scale * 0.55) % seam + seam) % seam;
      for (const side of [0, 1]) {
        const x0 = side ? view.w - w : 0;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, 0, w, view.h);
        ctx.clip();
        /* 底色：由外往內漸亮，做出圓弧感 */
        const g = ctx.createLinearGradient(x0, 0, x0 + w, 0);
        if (side) { g.addColorStop(0, scene.mid); g.addColorStop(1, scene.far); }
        else { g.addColorStop(0, scene.far); g.addColorStop(1, scene.mid); }
        ctx.fillStyle = g;
        ctx.fillRect(x0, 0, w, view.h);
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = 'rgba(60,38,18,.35)';
        ctx.fillRect(x0, 0, w, view.h);
        ctx.globalAlpha = 1;
        /* 縱向壁板 */
        const panel = Math.max(18, w / 4);
        ctx.strokeStyle = 'rgba(0,0,0,.16)';
        ctx.lineWidth = 1.5;
        for (let x = x0 + panel; x < x0 + w - 1; x += panel) {
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, view.h); ctx.stroke();
        }
        /* 橫向接縫：跟著鏡頭往上捲，往下墜的速度感就出來了 */
        ctx.strokeStyle = 'rgba(0,0,0,.13)';
        for (let y = -seam + drift; y < view.h + seam; y += seam) {
          ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); ctx.stroke();
          ctx.beginPath();
          ctx.strokeStyle = 'rgba(255,255,255,.12)';
          ctx.moveTo(x0, y + 1.5); ctx.lineTo(x0 + w, y + 1.5); ctx.stroke();
          ctx.strokeStyle = 'rgba(0,0,0,.13)';
        }
        /* 靠場地那一側壓一道陰影，場地邊界才清楚 */
        const edge = side ? x0 : x0 + w;
        const eg = ctx.createLinearGradient(edge, 0, edge + (side ? 14 : -14), 0);
        eg.addColorStop(0, 'rgba(0,0,0,.35)');
        eg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = eg;
        ctx.fillRect(side ? edge : edge - 14, 0, 14, view.h);
        ctx.restore();
      }
    }

    /** 深度輔助線（設定可開，每 10 公尺一條淡線） */
    function drawGuides(scene, camTop) {
      if (!opts.depthGuide) return;
      ctx.save();
      ctx.strokeStyle = scene.guide;
      ctx.fillStyle = scene.guide;
      ctx.lineWidth = 1;
      ctx.font = '600 11px system-ui, sans-serif';
      const from = Math.ceil(camTop / 10) * 10;
      for (let d = from; d < camTop + view.viewH; d += 10) {
        const y = py(d, camTop);
        ctx.beginPath(); ctx.moveTo(px(0), y); ctx.lineTo(px(fieldWidth()), y); ctx.stroke();
        ctx.fillText(d + 'm', px(0) + 4, y - 3);
      }
      ctx.restore();
    }

    /**
     * 一根金屬尖刺。天花板與刺階共用同一套外觀 ——
     * Eric：「刺階的刺不太明顯，可以跟天花板的一樣」。
     * 原本刺階畫的是扁平的淺色小三角（一根只有 12px 寬），在淺色背景上幾乎看不見；
     * 天花板那套是金屬漸層 ＋ 深色描邊 ＋ 一條高光，明顯得多。
     * @param fromY 根部的 y
     * @param tipY  尖端的 y（比 fromY 大就是朝下，小就是朝上）
     */
    function metalSpike(sx, cw, fromY, tipY) {
      const cx = sx + cw / 2;
      const sg = ctx.createLinearGradient(sx, 0, sx + cw, 0);
      sg.addColorStop(0, '#6E605C');
      sg.addColorStop(0.3, '#E6DEDA');
      sg.addColorStop(0.52, '#B9AAA4');
      sg.addColorStop(0.8, '#8A7A75');
      sg.addColorStop(1, '#4E4340');
      ctx.beginPath();
      ctx.moveTo(sx + 0.5, fromY);
      ctx.lineTo(cx, tipY);
      ctx.lineTo(sx + cw - 0.5, fromY);
      ctx.closePath();
      ctx.fillStyle = sg;
      ctx.fill();
      ctx.strokeStyle = 'rgba(48,6,6,.75)';
      ctx.lineWidth = Math.max(1.5, cw * 0.06);
      ctx.stroke();
      /* 沿著左緣的一條亮線，做出金屬感 */
      ctx.beginPath();
      ctx.moveTo(sx + cw * 0.3, fromY + (tipY - fromY) * 0.12);
      ctx.lineTo(cx - cw * 0.04, fromY + (tipY - fromY) * 0.86);
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = Math.max(1.5, cw * 0.08);
      ctx.stroke();
    }

    /* ---------- 階梯：五種都用不同形狀＋不同顏色＋不同動態 ---------- */

    function drawStep(st, scene, camTop, time) {
      const x0 = px(st.x0), x1 = px(st.x1);
      const w = x1 - x0;
      const y = py(st.depth, camTop);
      const h = Math.max(8, view.scale * 0.42);
      const assist = opts.colorAssist;

      ctx.save();
      if (st.breakIn != null && !st.broken) {
        ctx.globalAlpha = Math.max(0.25, st.breakIn / 0.25);
        if (!opts.reduceMotion) ctx.translate(Math.sin(time * 60) * 1.6, 0);
      }

      if (st.kind === 'spike') {
        /* 刺階：暗紅底座 ＋ 朝上的金屬尖刺，跟天花板完全同一套外觀 */
        const g = ctx.createLinearGradient(0, y, 0, y + h);
        g.addColorStop(0, scene.spike[1]);
        g.addColorStop(1, '#3D0A09');
        roundRect(x0, y, w, h, 4); ctx.fillStyle = g; ctx.fill();
        /* 底座上緣壓一條暗邊，刺的根部才有厚度（跟天花板一樣的做法） */
        ctx.fillStyle = 'rgba(0,0,0,.28)';
        ctx.fillRect(x0, y, w, Math.max(2, h * 0.16));

        /* 每根約 0.75 格寬 —— 跟天花板一樣少而大，才看得出是刺 */
        const stepW = Math.max(14, view.scale * 0.75);
        const n = Math.max(2, Math.round(w / stepW));
        const cw = w / n;
        const tip = h * 1.05;
        const wob = opts.reduceMotion ? 0 : Math.sin(time * 3.5) * (tip * 0.06);
        for (let i = 0; i < n; i++) {
          const sx = x0 + i * cw;
          metalSpike(sx, cw, y + h * 0.34, y - tip - (i % 2 ? wob : -wob));
        }
        if (assist) { ctx.strokeStyle = '#7A0F0C'; ctx.lineWidth = 3; roundRect(x0, y, w, h, 4); ctx.stroke(); }
        /* 剛剛刺到人：往外擴散的白色衝擊環 ＋ 很淡的一層白，很快淡掉。
         * 刻意不整片塗白 —— 塗滿的話閃的那一下會變成一塊認不出來的白方塊，
         * 玩家反而看不到自己是踩到什麼才扣血的。 */
        if (st.flash > 0) {
          const k = Math.min(1, st.flash / C_FLASH);
          const grow = (1 - k) * h * 1.6;
          ctx.save();
          ctx.globalAlpha = k * 0.32;
          ctx.fillStyle = '#FFFFFF';
          roundRect(x0 - 1, y - h * 0.75, w + 2, h * 1.75, 4);
          ctx.fill();
          ctx.globalAlpha = k * 0.9;
          ctx.strokeStyle = '#FFFFFF';
          ctx.lineWidth = 2 + k * 4;
          roundRect(x0 - 2 - grow, y - h * 0.78 - grow, w + 4 + grow * 2, h * 1.8 + grow * 2, 5 + grow);
          ctx.stroke();
          ctx.restore();
        }
      } else if (st.kind === 'fake') {
        /* 假階：顏色偏白 ＋ 邊緣裂痕 */
        const g = ctx.createLinearGradient(0, y, 0, y + h);
        g.addColorStop(0, scene.fake[0]); g.addColorStop(1, scene.fake[1]);
        roundRect(x0, y, w, h, 5); ctx.fillStyle = g; ctx.fill();
        ctx.strokeStyle = 'rgba(90,80,70,.55)'; ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (let i = 1; i < 4; i++) {
          const cx = x0 + w * (i / 4);
          ctx.moveTo(cx - 4, y + 1); ctx.lineTo(cx + 2, y + h * 0.55); ctx.lineTo(cx - 2, y + h - 1);
        }
        ctx.stroke();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = assist ? '#6B6156' : 'rgba(120,110,95,.7)';
        ctx.lineWidth = assist ? 3 : 2;
        roundRect(x0, y, w, h, 5); ctx.stroke();
        ctx.setLineDash([]);
      } else if (st.kind === 'spring') {
        /* 彈簧跳床：螺旋彈簧 ＋ 壓縮動畫 */
        const squash = st.squash ? Math.min(1, st.squash / 0.18) : 0;
        const top = y + squash * h * 0.5;
        ctx.strokeStyle = scene.spring[1];
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        /* 螺旋：疊起來的半橢圓，被踩到時壓扁 */
        const coilH = h * 1.25 * (1 - squash * 0.6);
        const turns = 3;
        const cw = Math.min(w * 0.5, h * 2.2);
        const cx = x0 + w / 2;
        for (let i = 0; i < turns; i++) {
          const cy = top + h * 0.55 + (i + 1) * (coilH / turns);
          ctx.beginPath();
          ctx.ellipse(cx, cy, cw / 2, coilH / turns * 0.72, 0, Math.PI * 0.08, Math.PI * 0.92);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(cx - cw / 2, top + h * 0.55);
        ctx.lineTo(cx - cw / 2, top + h * 0.55 + coilH);
        ctx.moveTo(cx + cw / 2, top + h * 0.55);
        ctx.lineTo(cx + cw / 2, top + h * 0.55 + coilH);
        ctx.stroke();
        const g = ctx.createLinearGradient(0, top, 0, top + h);
        g.addColorStop(0, scene.spring[0]); g.addColorStop(1, scene.spring[1]);
        roundRect(x0, top, w, h * 0.7, h * 0.35); ctx.fillStyle = g; ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.5)';
        roundRect(x0 + 4, top + 2, w - 8, h * 0.2, h * 0.1); ctx.fill();
        if (assist) {
          ctx.strokeStyle = '#7A2A44'; ctx.lineWidth = 3;
          roundRect(x0, top, w, h * 0.7, h * 0.35); ctx.stroke();
        }
      } else if (st.kind === 'belt') {
        /* 輸送帶：滾輪轉動 ＋ 明顯方向箭頭（不靠顏色深淺表達方向） */
        const g = ctx.createLinearGradient(0, y, 0, y + h);
        g.addColorStop(0, scene.belt[0]); g.addColorStop(1, scene.belt[1]);
        roundRect(x0, y, w, h, h * 0.5); ctx.fillStyle = g; ctx.fill();
        const dir = st.belt || 1;
        const rollR = h * 0.34;
        const spin = time * 5 * dir;
        ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 2;
        const rolls = Math.max(2, Math.round(w / (rollR * 3)));
        for (let i = 0; i < rolls; i++) {
          const cx = x0 + (i + 0.5) * (w / rolls);
          const cy = y + h / 2;
          ctx.beginPath(); ctx.arc(cx, cy, rollR, 0, Math.PI * 2); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(spin) * rollR, cy + Math.sin(spin) * rollR);
          ctx.stroke();
        }
        /* 方向箭頭畫在帶面上，深色底＋白邊，淺色主題也看得清楚；會順著方向流動 */
        const flow = ((time * 2.2 * dir) % 1 + 1) % 1;
        const arrows = Math.max(1, Math.floor(w / 26));
        for (let i = 0; i < arrows; i++) {
          const t = (i + flow) / arrows;
          const ax = x0 + 8 + t * (w - 16);
          const fade = Math.sin(t * Math.PI);
          ctx.globalAlpha = 0.35 + fade * 0.65;
          ctx.fillStyle = '#12293A';
          arrow(ax, y + h / 2, 7 * dir, 11);
          ctx.strokeStyle = 'rgba(255,255,255,.9)';
          ctx.lineWidth = 1.6;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        if (assist) { ctx.strokeStyle = '#1F3A4A'; ctx.lineWidth = 3; roundRect(x0, y, w, h, h * 0.5); ctx.stroke(); }
      } else {
        /* 普通階：木頭／磚塊，木紋與上緣高光 */
        const g = ctx.createLinearGradient(0, y, 0, y + h);
        g.addColorStop(0, scene.wood[0]); g.addColorStop(1, scene.wood[1]);
        roundRect(x0, y, w, h, 4); ctx.fillStyle = g; ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.35)';
        roundRect(x0 + 3, y + 2, w - 6, Math.max(2, h * 0.18), 2); ctx.fill();
        ctx.strokeStyle = scene.woodEdge; ctx.lineWidth = 1.4;
        for (let i = 1; i < 3; i++) {
          const gy = y + h * (i / 3);
          ctx.beginPath(); ctx.moveTo(x0 + 5, gy); ctx.lineTo(x1 - 5, gy); ctx.stroke();
        }
        if (st.wide) {
          ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 2;
          roundRect(x0, y, w, h, 4); ctx.stroke();
        }
      }
      ctx.restore();
    }

    /* ---------- 天花板 ---------- */

    /**
     * 天花板：畫在畫面最上面留出來的 [0, offY] 這段裡，
     * 刺尖剛好落在 offY（＝ cameraTop，也就是真正會扣血的那條線），
     * 所以「看起來碰到刺」和「真的被扣血」是同一件事。
     */
    function drawCeiling(scene, cloud, time) {
      const H = view.offY;                         /* 整條天花板可以用的高度 */
      ctx.save();
      if (cloud) {
        /* 幼幼班：軟綿綿的雲朵，完全不畫尖刺 */
        const r = H * 0.52;
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, view.w, H * 0.5);
        const n = Math.max(4, Math.round(view.w / (r * 1.5)));
        for (let i = 0; i <= n; i++) {
          const cx = (i / n) * view.w;
          const rr = r * (0.9 + 0.18 * Math.sin(i * 1.3 + time * 1.2));
          ctx.beginPath();
          ctx.arc(cx, H * 0.5 - rr * 0.25, rr, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = 'rgba(186,212,234,.5)';
        for (let i = 0; i <= n; i++) {
          const cx = (i / n) * view.w;
          ctx.beginPath();
          ctx.ellipse(cx, H * 0.62, r * 0.62, r * 0.24, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
        return;
      }

      /* ---- 天花板的刺：整局唯一在追殺你的東西，一眼就要看得出很兇 ---- */
      const base = H * 0.34;                       /* 上面那條底座 */
      const tip = H - base;                        /* 尖刺長度：剩下的全給它 */
      const g = ctx.createLinearGradient(0, 0, 0, base);
      g.addColorStop(0, '#3D0A09');
      g.addColorStop(0.5, scene.spike[1]);
      g.addColorStop(1, scene.spike[0]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, view.w, base);
      /* 底座下緣壓一條暗邊，刺的根部才有厚度 */
      ctx.fillStyle = 'rgba(0,0,0,.3)';
      ctx.fillRect(0, base - Math.max(2, H * 0.05), view.w, Math.max(3, H * 0.06));

      /* 尖刺：每根約 0.75 格寬（比原本少而大）；金屬漸層 ＋ 深色描邊 ＋ 高光 */
      const stepW = Math.max(16, view.scale * 0.75);
      const n = Math.max(4, Math.round(view.w / stepW));
      const cw = view.w / n;
      const wob = opts.reduceMotion ? 0 : Math.sin(time * 3.5) * (tip * 0.05);
      for (let i = 0; i < n; i++) {
        const sx = i * cw;
        const len = base + tip + (i % 2 ? wob : -wob);
        metalSpike(sx, cw, base * 0.55, len);
      }
      if (opts.colorAssist) {
        ctx.strokeStyle = '#5A0B0A';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(view.w, H); ctx.stroke();
      }
      ctx.restore();
    }

    /** 場地下緣以外的「外面」：畫成暗色，讓玩家看得出掉出去就沒了 */
    function drawVoid() {
      if (view.fieldBottom >= view.h - 0.5) return;
      ctx.save();
      const g = ctx.createLinearGradient(0, view.fieldBottom, 0, Math.min(view.h, view.fieldBottom + 40));
      g.addColorStop(0, 'rgba(30,16,8,.55)');
      g.addColorStop(1, 'rgba(20,10,5,.85)');
      ctx.fillStyle = g;
      ctx.fillRect(0, view.fieldBottom, view.w, view.h - view.fieldBottom);
      ctx.restore();
    }

    /* ---------- 沉出畫面下緣的警示 ---------- */

    /**
     * 玩家掉得比鏡頭快、開始往畫面下緣沉下去時，在下緣畫一條會脈動的紅帶與往下的箭頭。
     * 沒有這個的話玩家只會覺得「我怎麼突然就死了」—— 死法要看得懂。
     */
    function drawSinkWarning(state, time) {
      let worst = 0;
      for (const p of state.players) if (p.alive && p.sinking > 0) worst = Math.max(worst, p.sinking);
      if (worst <= 0) return;
      /* sinking 從 0 到約 5.6 格就會掉出去，換算成 0～1 的危險程度 */
      const k = Math.min(1, worst / 5.6);
      const pulse = opts.reduceMotion ? 1 : 0.8 + 0.2 * Math.sin(time * 14);
      const bottom = view.fieldBottom;
      const band = Math.max(60, view.viewH * view.scale * 0.24);
      const bar = Math.max(16, view.viewH * view.scale * 0.035);
      ctx.save();
      ctx.globalAlpha = pulse;

      /* 由淡轉濃的紅色危險區 */
      const g = ctx.createLinearGradient(0, bottom - band, 0, bottom - bar);
      g.addColorStop(0, 'rgba(214,25,40,0)');
      g.addColorStop(1, 'rgba(214,25,40,' + (0.45 + 0.4 * k).toFixed(3) + ')');
      ctx.fillStyle = g;
      ctx.fillRect(0, bottom - band, view.w, band - bar);

      /* 畫面最下緣一條實心紅條 ＝ 掉過這裡就沒了。
       * 箭頭畫在紅條上（白色在淺色背景會看不見，一定要有底才行）。 */
      ctx.fillStyle = 'rgba(198,20,36,' + (0.8 + 0.2 * k).toFixed(3) + ')';
      ctx.fillRect(0, bottom - bar, view.w, bar);
      ctx.fillStyle = '#FFFFFF';
      const n = 5;
      for (let i = 0; i < n; i++) {
        const cx = view.w * ((i + 0.5) / n);
        const cy = bottom - bar / 2;
        const sz = bar * (0.3 + 0.12 * k);
        ctx.beginPath();
        ctx.moveTo(cx - sz, cy - sz * 0.65);
        ctx.lineTo(cx + sz, cy - sz * 0.65);
        ctx.lineTo(cx, cy + sz * 0.75);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    /* ---------- 粒子與畫面震動（開了「減少動態」就全部關掉） ---------- */

    const PALETTE = {
      fake: ['#FFF8EC', '#D8CDBB', '#B9AC96'],
      spike: ['#FF6B5E', '#FFD1CA', '#FFFFFF'],
      spring: ['#FFE066', '#FF9BB0', '#FFFFFF'],
      milestone: ['#FF8FB1', '#7FC8F8', '#FFD44D', '#9BDE7E', '#B79CED']
    };

    function burst(kind, x, y, camTop) {
      if (opts.reduceMotion) return;
      const cx = px(x), cy = py(y, camTop);
      const palette = PALETTE[kind] || ['#FFFFFF'];
      const party = kind === 'milestone';
      const n = party ? 46 : kind === 'spike' ? 26 : 14;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 40 + Math.random() * (party ? 260 : 140);
        particles.push({
          x: party ? view.w * 0.5 + (Math.random() - 0.5) * view.w * 0.8 : cx,
          y: party ? view.h * 0.28 + (Math.random() - 0.5) * 60 : cy,
          vx: Math.cos(a) * sp,
          vy: party ? 60 + Math.random() * 120
            : Math.sin(a) * sp - (kind === 'spike' ? 120 : 40),
          life: party ? 1.4 : 0.6,
          max: party ? 1.4 : 0.6,
          size: 2 + Math.random() * (party ? 5 : 3),
          color: palette[Math.floor(Math.random() * palette.length)],
          spin: Math.random() * 6
        });
      }
      if (particles.length > 420) particles = particles.slice(-420);
    }

    function kick(power) {
      if (opts.reduceMotion) return;
      shake = Math.max(shake, power);
    }

    function stepParticles(dt) {
      for (const p of particles) {
        p.life -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 420 * dt;
        p.spin += dt * 8;
      }
      if (particles.length) particles = particles.filter(p => p.life > 0);
      shake = Math.max(0, shake - dt * 40);
    }

    function drawParticles() {
      for (const p of particles) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life / p.max);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size, -p.size * 0.6, p.size * 2, p.size * 1.2);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    /* ---------- 角色層（SVG 疊在 Canvas 上面） ---------- */

    function syncActors(state, charOf) {
      if (!actorSvg) return;
      const seen = new Set();
      state.players.forEach((p, i) => {
        seen.add(p.id);
        if (actors.has(p.id)) return;
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('class', 'actor');
        const inner = document.createElementNS(NS, 'g');
        inner.setAttribute('class', 'actor-kid');
        /* 玩家色外框：玩家 1 藍、玩家 2 紅（同房選同一隻也分得清） */
        const ring = state.players.length > 1 ? (i === 0 ? '#4F86D6' : '#F2545B') : null;
        inner.innerHTML = buildKid(charOf(p.char), {
          id: 'act-' + p.id,
          ring: ring,
          halo: p.kind === 'human' ? '#FFE066' : null
        });
        g.appendChild(inner);
        const label = document.createElementNS(NS, 'text');
        label.setAttribute('class', 'actor-name');
        label.setAttribute('text-anchor', 'middle');
        label.textContent = p.name;
        g.appendChild(label);
        actorSvg.appendChild(g);
        actors.set(p.id, { g: g, inner: inner, label: label, turn: 0, mirror: 1 });
      });
      for (const [id, a] of actors) {
        if (!seen.has(id)) { a.g.remove(); actors.delete(id); }
      }
    }

    const TURN_TIME = 0.11;               /* 正面↔側身轉過去要多久（秒） */

    function drawActors(state, time, dt) {
      const pw = playerW(), ph = playerH();
      const k = view.scale * pw / 100;     /* 本地 100 單位 = PLAYER_W 格 */
      for (const p of state.players) {
        const a = actors.get(p.id);
        if (!a) continue;
        /* 朝向：面向左右時轉成側臉，沒在動就轉回正面。
         * 中間插值是為了讓快速左右點按不會一格一格抽動；
         * mirror 記住最後一次的左右，回正面時才不會突然翻面。 */
        if (p.face) a.mirror = p.face;
        const wantTurn = p.face ? 1 : 0;
        const rate = (dt || 0) / TURN_TIME;
        a.turn += Math.max(-rate, Math.min(rate, wantTurn - a.turn));
        if (rate <= 0 || Math.abs(wantTurn - a.turn) < 0.02) a.turn = wantTurn;
        const x = px(p.x) - view.scale * pw / 2;
        const y = py(p.y, state.cameraTop) - view.scale * ph;
        a.g.setAttribute('transform', 'translate(' + x.toFixed(1) + ',' + y.toFixed(1) + ')');
        a.inner.setAttribute('transform', 'scale(' + k.toFixed(4) + ')');
        const pose = !p.alive ? 'stun'
          : p.state === 'ceiling' ? 'ceiling'
          : p.state === 'spring' ? 'spring'
          : p.state === 'fall' ? 'fall'
          : p.state === 'walk' ? 'walk' : 'idle';
        poseKid(a.inner, pose, time, { face: a.mirror, turn: a.turn });
        a.g.setAttribute('opacity', (p.invuln > 0 && Math.floor(time * 14) % 2) ? '0.45' : '1');
        a.label.setAttribute('x', (view.scale * pw / 2).toFixed(1));
        a.label.setAttribute('y', '-6');
        a.label.setAttribute('font-size', Math.max(10, Math.min(16, view.scale * 0.42)).toFixed(1));
        a.label.style.display = state.players.length > 1 ? '' : 'none';
      }
    }

    /* ---------- 畫一格 ---------- */

    function draw(state, scene, charOf, time, dt) {
      stepParticles(dt || 0);
      ctx.save();
      ctx.scale(view.dpr, view.dpr);
      ctx.clearRect(0, 0, view.w, view.h);
      if (shake > 0.01) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);

      drawBackground(scene, state.cameraTop);
      drawGuides(scene, state.cameraTop);

      const top = state.cameraTop - 2, bottom = state.cameraTop + view.viewH + 2;
      for (const st of state.steps) {
        if (st.broken) continue;
        if (st.squash) st.squash = Math.max(0, st.squash - (dt || 0));
        if (st.flash) st.flash = Math.max(0, st.flash - (dt || 0));
        if (st.depth < top || st.depth > bottom) continue;
        drawStep(st, scene, state.cameraTop, time);
      }
      drawCeiling(scene, state.diff.cloudCeiling, time);
      drawVoid();
      drawSinkWarning(state, time);
      drawParticles();
      ctx.restore();

      syncActors(state, charOf);
      drawActors(state, time, dt || 0);
    }

    function clearActors() {
      for (const [, a] of actors) a.g.remove();
      actors.clear();
      particles = [];
      shake = 0;
    }

    return {
      resize, setOptions, draw, burst, kick, clearActors,
      get view() { return view; },
      worldToPx(x, y, camTop) { return { x: px(x), y: py(y, camTop) }; }
    };
  }

  root.Render = { create, buildKid, poseKid, kidAvatarSvg, kidFullSvg };
})(typeof self !== 'undefined' ? self : this);
