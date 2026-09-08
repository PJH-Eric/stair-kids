/* ===== themes/scenes.js — 六套世界（純資料） =====
 * 隨深度每 100 公尺換下一層世界（規劃書 §8）。六套用完循環，並套「夜間配色」變體。
 * 主題只換美術，不改任何規則（階梯機率、速度都由難度決定）。
 */
(function (root) {
  'use strict';

  const SCENES = [
    {
      id: 'kindergarten', name: '幼稚園', hint: '積木與彩色地墊',
      sky: ['#FFF6E0', '#FFE0BF'], far: '#FFD3A8', mid: '#F6BE86',
      wood: ['#E8A55C', '#B87333'], woodEdge: '#8C5320',
      belt: ['#8FA7C4', '#5C7796'], spring: ['#F27C9B', '#C74F70'],
      spike: ['#F0554F', '#B32C28'], fake: ['#FBF6EE', '#D8CDBB'],
      deco: 'blocks', decoColors: ['#FF8FB1', '#7FC8F8', '#FFD44D', '#9BDE7E'],
      guide: 'rgba(120,80,40,.18)', text: '#5A3B1E',
      night: { sky: ['#3B3358', '#241E3C'], far: '#2E2749', mid: '#241E3C', text: '#F0E9FF', guide: 'rgba(255,255,255,.14)' }
    },
    {
      id: 'park', name: '公園', hint: '草地、樹與鞦韆',
      sky: ['#DFF3FF', '#B8E4F5'], far: '#A5D8B4', mid: '#7FC08F',
      wood: ['#C79A5E', '#8F6636'], woodEdge: '#6B4A24',
      belt: ['#7FA3B8', '#4E7387'], spring: ['#F2985C', '#C46C33'],
      spike: ['#E8514B', '#A82823'], fake: ['#F7F4EC', '#D2CBBA'],
      deco: 'trees', decoColors: ['#5FA96E', '#7FC08F', '#C3E6A8', '#E4B45C'],
      guide: 'rgba(40,90,50,.18)', text: '#2C4A32',
      night: { sky: ['#243B52', '#16273A'], far: '#1F3B33', mid: '#172C27', text: '#DDF3E6', guide: 'rgba(255,255,255,.14)' }
    },
    {
      id: 'seaside', name: '海邊', hint: '沙、貝殼與浪花',
      sky: ['#E6F7FF', '#BDEBFA'], far: '#8FD9F0', mid: '#F2E0B8',
      wood: ['#E9D3A3', '#C0A470'], woodEdge: '#93794A',
      belt: ['#6FBBD6', '#3F8AA6'], spring: ['#F58FA8', '#C55C77'],
      spike: ['#EF5A52', '#AE2C26'], fake: ['#FFFDF6', '#DCD6C4'],
      deco: 'shells', decoColors: ['#FFC9D4', '#9EE6F5', '#FFE7B8', '#F2A98F'],
      guide: 'rgba(30,90,120,.18)', text: '#22536B',
      night: { sky: ['#1F3550', '#122238'], far: '#1B4258', mid: '#2A3A4A', text: '#D6EEFA', guide: 'rgba(255,255,255,.14)' }
    },
    {
      id: 'forest', name: '森林', hint: '樹根、蕈菇與螢火蟲',
      sky: ['#DCEFD6', '#A9CFA0'], far: '#7BA871', mid: '#4F7A4C',
      wood: ['#9A6E42', '#68472A'], woodEdge: '#4A3220',
      belt: ['#7C8F63', '#4F5F3B'], spring: ['#D97CA6', '#A54E78'],
      spike: ['#E04F45', '#A02722'], fake: ['#F0EFE2', '#CBC8B4'],
      deco: 'roots', decoColors: ['#E8734F', '#F2D06B', '#7FBF6A', '#A8D8F0'],
      guide: 'rgba(30,60,30,.20)', text: '#28442A',
      night: { sky: ['#1B2E24', '#101E18'], far: '#1B3A2A', mid: '#132A1F', text: '#D8F0DE', guide: 'rgba(255,255,255,.16)' }
    },
    {
      id: 'candy', name: '糖果屋', hint: '棒棒糖、餅乾階與糖霜',
      sky: ['#FFF0F7', '#FFD3E6'], far: '#FFBEDC', mid: '#F79FC6',
      wood: ['#F0C48A', '#C28E52'], woodEdge: '#96683A',
      belt: ['#C79AE8', '#966BB8'], spring: ['#FF7FA8', '#CC4F79'],
      spike: ['#F04A6E', '#B02444'], fake: ['#FFFBFD', '#E4D4DE'],
      deco: 'candy', decoColors: ['#FF8FB1', '#8FD9F0', '#FFE066', '#B79CED'],
      guide: 'rgba(150,60,110,.18)', text: '#7A2B50',
      night: { sky: ['#3A1E3A', '#251325'], far: '#4A2448', mid: '#331A33', text: '#FFE3F2', guide: 'rgba(255,255,255,.16)' }
    },
    {
      id: 'station', name: '太空站', hint: '金屬、星空與失重粒子',
      sky: ['#1B2440', '#0E1428'], far: '#26325A', mid: '#1A2244',
      wood: ['#A8B4C8', '#6B7891'], woodEdge: '#48536B',
      belt: ['#7FE0D8', '#3FA8A0'], spring: ['#FF9F5C', '#CC6F2E'],
      spike: ['#FF5A6E', '#B82440'], fake: ['#E8EEF7', '#B8C2D2'],
      deco: 'space', decoColors: ['#7FE0D8', '#FFD44D', '#B79CED', '#FFFFFF'],
      guide: 'rgba(200,220,255,.16)', text: '#DCE6FF',
      night: { sky: ['#0A0E1C', '#05070F'], far: '#131A33', mid: '#0C1226', text: '#EAF0FF', guide: 'rgba(255,255,255,.18)' }
    }
  ];

  /** 世界編號 → 這一層要用的主題（六套循環，第二輪起套夜間配色） */
  function sceneFor(world) {
    const n = SCENES.length;
    const i = ((world % n) + n) % n;
    const night = Math.floor(world / n) % 2 === 1;
    const base = SCENES[i];
    if (!night) return Object.assign({}, base, { night: false, worldIndex: i });
    return Object.assign({}, base, base.night, { night: true, worldIndex: i, name: base.name + '（夜）' });
  }

  const api = { SCENES, sceneFor, COUNT: SCENES.length };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Scenes = api;
})(typeof self !== 'undefined' ? self : this);
