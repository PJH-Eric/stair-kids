/* ===== themes/characters.js — 8 隻小朋友（純資料） =====
 * 能力完全相同，只差外觀。真正的向量圖形在 render.js 的 buildKid() 手繪，
 * 這裡只放可替換的配色與造型參數（規劃書 §14.9：純資料格式保持可替換）。
 *
 * hair：bob 妹妹頭｜twin 雙馬尾｜short 短髮｜curly 捲髮｜pony 單馬尾｜buzz 小平頭｜wave 波浪｜bun 包包頭
 * top ：tee 短袖｜dress 洋裝｜overall 吊帶褲｜hoodie 連帽｜stripe 條紋
 */
(function (root) {
  'use strict';

  const CHARACTERS = [
    {
      id: 'yuan', name: '圓圓', hair: 'bob', top: 'dress',
      skin: '#FFDCC0', skinDark: '#E9B994',
      hairColor: '#4B3B36', hairDark: '#2E241F',
      shirt: '#FF8FB1', shirtDark: '#DB5E88', pants: '#FFC2D6', pantsDark: '#E093AE',
      shoe: '#F2545B', accent: '#FFE9F0'
    },
    {
      id: 'bobo', name: '波波', hair: 'short', top: 'overall',
      skin: '#FFD2AE', skinDark: '#E3AC84',
      hairColor: '#33526E', hairDark: '#20364A',
      shirt: '#FFF4DC', shirtDark: '#E6D8B8', pants: '#4F86D6', pantsDark: '#315EA4',
      shoe: '#2F4A6D', accent: '#9CC7FF'
    },
    {
      id: 'dodo', name: '豆豆', hair: 'buzz', top: 'tee',
      skin: '#E8B487', skinDark: '#C9905F',
      hairColor: '#2B2320', hairDark: '#161110',
      shirt: '#6FC46A', shirtDark: '#469243', pants: '#3F6B3C', pantsDark: '#2A4A28',
      shoe: '#E0A81E', accent: '#DDF3C9'
    },
    {
      id: 'tao', name: '桃桃', hair: 'twin', top: 'dress',
      skin: '#FFE2CB', skinDark: '#EDBE9F',
      hairColor: '#8A4B2E', hairDark: '#5E3120',
      shirt: '#FFB4A2', shirtDark: '#E08573', pants: '#FF9F7A', pantsDark: '#D97552',
      shoe: '#B8562F', accent: '#FFE0D2'
    },
    {
      id: 'mimi', name: '小米', hair: 'bun', top: 'stripe',
      skin: '#F7CBA5', skinDark: '#D8A379',
      hairColor: '#1F1B1A', hairDark: '#0E0C0C',
      shirt: '#FFD44D', shirtDark: '#E0A81E', pants: '#7B5EA7', pantsDark: '#54407A',
      shoe: '#4A3A66', accent: '#FFF0B8'
    },
    {
      id: 'shu', name: '阿樹', hair: 'curly', top: 'hoodie',
      skin: '#C98A5B', skinDark: '#A66A3E',
      hairColor: '#2E1F1A', hairDark: '#180F0C',
      shirt: '#59B98B', shirtDark: '#36906A', pants: '#E4DCC8', pantsDark: '#C2B79E',
      shoe: '#2F6B52', accent: '#CFF0DF'
    },
    {
      id: 'hai', name: '阿海', hair: 'wave', top: 'tee',
      skin: '#FFD9BB', skinDark: '#E4B18C',
      hairColor: '#2C4A63', hairDark: '#182C3D',
      shirt: '#4FC0E8', shirtDark: '#2E9BC4', pants: '#F2F6F9', pantsDark: '#CFD9E2',
      shoe: '#1F6E8C', accent: '#CFEFFA'
    },
    {
      id: 'xing', name: '星星', hair: 'pony', top: 'hoodie',
      skin: '#FFE6D0', skinDark: '#E7C0A4',
      hairColor: '#6B3FA0', hairDark: '#472772',
      shirt: '#B79CED', shirtDark: '#8E70C9', pants: '#3B3B5C', pantsDark: '#26263D',
      shoe: '#E8E1FF', accent: '#FFF2A8'
    }
  ];

  const byId = id => CHARACTERS.find(c => c.id === id) || CHARACTERS[0];

  const api = { CHARACTERS, byId };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Characters = api;
})(typeof self !== 'undefined' ? self : this);
