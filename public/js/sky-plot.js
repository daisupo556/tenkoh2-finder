/* ==========================================================
   sky-plot.js — 極座標スカイプロット (Canvas描画)
   外周=地平線(0°)、中心=天頂(90°)
   ========================================================== */

const SkyPlot = (function() {

  let canvas, ctx;
  let size = 0, cx = 0, cy = 0, radius = 0;

  function init(canvasId) {
    canvas = document.getElementById(canvasId);
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    resize();
  }

  function resize() {
    if (!canvas) return;
    // Canvas属性サイズを使用（CSSで200x200、属性で400x400=2x DPR）
    size = canvas.width; // 400
    cx = size / 2;
    cy = size / 2;
    radius = (size / 2) - 28;
  }

  /**
   * 方位角(度)・仰角(度) → Canvas座標
   */
  function toXY(azDeg, elDeg) {
    const r = ((90 - Math.max(0, elDeg)) / 90) * radius;
    const azRad = azDeg * Math.PI / 180;
    return {
      x: cx + r * Math.sin(azRad),
      y: cy - r * Math.cos(azRad)
    };
  }

  /**
   * スカイプロットを描画する
   * @param {Object|null} currentLook - { azimuth, elevation } 現在の衛星位置
   * @param {Array|null} passTrack - [{ azimuth, elevation }] 通過軌跡
   * @param {Array|null} allPasses - 全通過のリスト（次の通過トラック描画用）
   */
  function draw(currentLook, passTrack, allPasses) {
    if (!ctx) return;
    resize();

    // Canvas 400px → CSS 200px = 2倍スケール
    const s = 2;
    ctx.clearRect(0, 0, size, size);

    // --- 背景 ---
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.fill();

    // --- 同心円 (30°, 60°) ---
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1.5;
    for (const el of [30, 60]) {
      const r = ((90 - el) / 90) * radius;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // --- 外周円 (地平線 0°) ---
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // --- 十字線 (N-S, E-W) ---
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.stroke();

    // --- 方位ラベル ---
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', cx, cy - radius - 16);
    ctx.fillText('S', cx, cy + radius + 16);
    ctx.fillText('E', cx + radius + 16, cy);
    ctx.fillText('W', cx - radius - 16, cy);

    // --- 仰角ラベル ---
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.font = '16px system-ui, sans-serif';
    const r30 = ((90 - 30) / 90) * radius;
    const r60 = ((90 - 60) / 90) * radius;
    ctx.fillText('30°', cx + r30 + 4, cy - 6);
    ctx.fillText('60°', cx + r60 + 4, cy - 6);

    // --- 通過軌跡の描画 ---
    if (passTrack && passTrack.length >= 2) {
      ctx.beginPath();
      const p0 = toXY(passTrack[0].azimuth, passTrack[0].elevation);
      ctx.moveTo(p0.x, p0.y);

      for (let i = 1; i < passTrack.length; i++) {
        const p = toXY(passTrack[i].azimuth, passTrack[i].elevation);
        ctx.lineTo(p.x, p.y);
      }

      ctx.strokeStyle = 'rgba(86, 214, 255, 0.6)';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      ctx.stroke();
      ctx.setLineDash([]);

      // AOS マーク
      ctx.fillStyle = 'rgba(86, 214, 255, 0.8)';
      ctx.font = '18px system-ui';
      ctx.fillText('AOS', p0.x, p0.y + 20);

      // LOS マーク
      const pLast = toXY(passTrack[passTrack.length - 1].azimuth, passTrack[passTrack.length - 1].elevation);
      ctx.fillText('LOS', pLast.x, pLast.y + 20);
    }

    // --- 衛星の現在位置 ---
    if (currentLook && currentLook.elevation > 0) {
      const sp = toXY(currentLook.azimuth, currentLook.elevation);

      // グロー効果
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 14, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 209, 255, 0.2)';
      ctx.fill();

      // 外円
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 8, 0, Math.PI * 2);
      ctx.strokeStyle = '#00d1ff';
      ctx.lineWidth = 2;
      ctx.stroke();

      // 中心点
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#00d1ff';
      ctx.fill();
    }
  }

  return {
    init: init,
    draw: draw,
    toXY: toXY
  };
})();
