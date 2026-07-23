/* ==========================================================
   ar-mode.js — ARファインダーモード制御

   設計方針(重要): 軌道の線そのものは画面上に固定して描く。
   カメラ視点に合わせて線を動かす("ワールドロックAR")方式は、
   コンパスのドリフトやロールの影響を受けやすく、線が意図せず
   ズレて見える問題が解消しきれなかったため採用しない。

   代わりに、軌道(方位角×仰角)を固定のグラフとして常に同じ位置に
   描き、その上を「今向けている方位」を示す縦線(カーソル)が
   左右にスライドする方式にする。カーソルが軌道線と交わる位置に、
   その時刻を表示する。線は動かず、カーソルだけが動く。
   ========================================================== */

const ARMode = (function() {
  let stream = null;

  let currentHeading = 0;  // 0-360, 真北基準の想定 (磁北からの偏角補正は未実装)
  let currentPitch = 0;    // -90=真下, 0=水平線, 90=天頂 (参考表示用。グラフのY軸には使わない)
  let hasOrientationData = false;

  const TOLERANCE_DEG = 15;   // 4エレ八木の指向性を踏まえた許容誤差 (LOCK ON判定用)
  const SMOOTH_FACTOR = 0.25; // センサー値の平滑化係数
  const CHART_MARGIN_X = 24;
  const MIN_AZ_SPAN = 70;     // 軌道の方位角の幅がこれより狭い場合、見やすさのため最低限確保する

  function smoothAngle(current, target, factor) {
    let diff = target - current;
    diff = (diff + 180 + 360) % 360 - 180;
    return (current + diff * factor + 360) % 360;
  }

  function handleOrientation(event) {
    let rawHeading = currentHeading;
    if (event.webkitCompassHeading !== undefined) {
      rawHeading = event.webkitCompassHeading;
    } else if (event.alpha !== null) {
      rawHeading = (360 - event.alpha) % 360;
    }
    const rawPitch = (event.beta !== null) ? event.beta - 90 : currentPitch;

    if (!hasOrientationData) {
      currentHeading = rawHeading;
      currentPitch = rawPitch;
      hasOrientationData = true;
    } else {
      currentHeading = smoothAngle(currentHeading, rawHeading, SMOOTH_FACTOR);
      currentPitch += (rawPitch - currentPitch) * SMOOTH_FACTOR;
    }
  }

  async function requestCameraPermission() {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    });
    return stream;
  }

  function requestOrientationPermission() {
    return new Promise((resolve, reject) => {
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
          .then((state) => {
            if (state === 'granted') {
              window.addEventListener('deviceorientation', handleOrientation, true);
              resolve();
            } else {
              reject(new Error('センサーの利用が許可されませんでした'));
            }
          })
          .catch(reject);
      } else {
        window.addEventListener('deviceorientation', handleOrientation, true);
        resolve();
      }
    });
  }

  function attachStreamToVideo(videoEl) {
    if (stream && videoEl) {
      videoEl.srcObject = stream;
    }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  /**
   * 方位角の並びを「連続」になるよう unwrap する (0°/360°またぎ対策)。
   * 例: 350°, 355°, 2°, 8° → 350°, 355°, 362°, 368°
   */
  function unwrapAzimuths(azimuths) {
    const out = [azimuths[0]];
    for (let i = 1; i < azimuths.length; i++) {
      let a = azimuths[i];
      const prev = out[i - 1];
      while (a - prev > 180) a -= 360;
      while (a - prev < -180) a += 360;
      out.push(a);
    }
    return out;
  }

  /**
   * 与えられた基準範囲に対して、角度(0-360)をunwrapする
   * (rangeの中心にもっとも近くなるよう360度単位で調整)
   */
  function unwrapToRange(angle, rangeCenter) {
    let a = angle;
    while (a - rangeCenter > 180) a -= 360;
    while (a - rangeCenter < -180) a += 360;
    return a;
  }

  function elToY(el, chartTop, chartBottom) {
    const clamped = Math.max(0, Math.min(90, el));
    return chartTop + (90 - clamped) / 90 * (chartBottom - chartTop);
  }

  /**
   * 通過軌跡の中で、カーソル方位(headingUnwrapped)が交わる位置を線形補間で求める
   */
  function findIntersection(passTrack, azsUnwrapped, headingUnwrapped) {
    for (let i = 0; i < passTrack.length - 1; i++) {
      const a0 = azsUnwrapped[i], a1 = azsUnwrapped[i + 1];
      if (a0 === a1) continue;
      if ((headingUnwrapped - a0) * (headingUnwrapped - a1) > 0) continue;
      const t = (headingUnwrapped - a0) / (a1 - a0);
      const elevation = passTrack[i].elevation + t * (passTrack[i + 1].elevation - passTrack[i].elevation);
      const time = new Date(passTrack[i].time.getTime() + t * (passTrack[i + 1].time.getTime() - passTrack[i].time.getTime()));
      return { elevation, time };
    }
    return null;
  }

  /**
   * 毎フレームのAR表示更新
   * @param {Object|null} lookAngles - { azimuth, elevation } 現在の衛星位置
   * @param {boolean} hasSatrec
   * @param {boolean} hasObserverCoords
   * @param {Array} passTrack - [{azimuth, elevation, time}] 軌道上の通過ポイント列 (現在/次の通過)
   * @param {Object} els - 関連DOM/Canvas要素一式
   */
  function update(lookAngles, hasSatrec, hasObserverCoords, passTrack, els) {
    const canvas = els.canvas;
    const ctx = canvas.getContext('2d');
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const w = window.innerWidth || document.documentElement.clientWidth;
    const h = window.innerHeight || document.documentElement.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const topInfoEl = els.guideText && els.guideText.closest('.ar-top-info');
    const chartTop = (topInfoEl ? topInfoEl.getBoundingClientRect().bottom : 90) + 50;
    const chartBottom = h - 150;

    if (!hasObserverCoords) {
      els.guideText.textContent = '📍 位置情報を取得できていません';
      if (els.reticle) els.reticle.classList.remove('--locked');
      if (els.aimTime) els.aimTime.classList.remove('--show');
      return;
    }
    if (!hasSatrec) {
      els.guideText.textContent = '🛰️ TLE衛星データを取得中...';
      if (els.reticle) els.reticle.classList.remove('--locked');
      if (els.aimTime) els.aimTime.classList.remove('--show');
      return;
    }

    let range = null, azsUnwrapped = null;

    if (passTrack && passTrack.length >= 2) {
      // --- 固定の方位角レンジを決定 (これが決まればグラフは画面上で一切動かない) ---
      const rawAzs = passTrack.map((p) => p.azimuth);
      azsUnwrapped = unwrapAzimuths(rawAzs);
      let min = Math.min(...azsUnwrapped);
      let max = Math.max(...azsUnwrapped);
      if (max - min < MIN_AZ_SPAN) {
        const center = (min + max) / 2;
        min = center - MIN_AZ_SPAN / 2;
        max = center + MIN_AZ_SPAN / 2;
      }
      const pad = (max - min) * 0.08;
      range = { min: min - pad, max: max + pad };

      const azToX = (azUnwrapped) => CHART_MARGIN_X + (azUnwrapped - range.min) / (range.max - range.min) * (w - CHART_MARGIN_X * 2);

      // --- ドーム風の水平グリッド線 (仰角30°/60°/90°) ---
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.textBaseline = 'middle';
      [0, 30, 60, 90].forEach((el) => {
        const y = elToY(el, chartTop, chartBottom);
        ctx.beginPath();
        ctx.setLineDash(el === 0 ? [] : [4, 5]);
        ctx.moveTo(CHART_MARGIN_X, y);
        ctx.lineTo(w - CHART_MARGIN_X, y);
        ctx.stroke();
        ctx.fillText(el + '°', 4, y);
      });
      ctx.setLineDash([]);
      ctx.restore();

      // --- 方位磁針テープ (このグラフと同じ方位角レンジを共有、常に固定) ---
      drawCompassTape(ctx, w, range, azToX, (topInfoEl ? topInfoEl.getBoundingClientRect().bottom : 90) + 8);

      // --- 軌道ライン (固定。フレームごとに再描画されるが位置は変わらない) ---
      ctx.save();
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(86, 214, 255, 0.9)';
      ctx.shadowColor = 'rgba(86, 214, 255, 0.9)';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      passTrack.forEach((p, i) => {
        const x = azToX(azsUnwrapped[i]);
        const y = elToY(p.elevation, chartTop, chartBottom);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();

      // --- 通過点ドット (約1分間隔) ---
      let lastDotMin = null;
      const nowMs = Date.now();
      passTrack.forEach((p, i) => {
        const minFromNow = Math.round((p.time.getTime() - nowMs) / 60000);
        if (lastDotMin !== null && minFromNow === lastDotMin) return;
        lastDotMin = minFromNow;
        const x = azToX(azsUnwrapped[i]);
        const y = elToY(p.elevation, chartTop, chartBottom);
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(10, 18, 24, 0.85)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(86, 214, 255, 0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
      });

      // --- 現在向けている方位のカーソル (これだけが左右に動く) ---
      const headingUnwrapped = unwrapToRange(currentHeading, (range.min + range.max) / 2);
      const cursorInRange = headingUnwrapped >= range.min && headingUnwrapped <= range.max;

      if (cursorInRange) {
        const cx = azToX(headingUnwrapped);
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(cx, chartTop - 10);
        ctx.lineTo(cx, chartBottom + 10);
        ctx.stroke();
        ctx.restore();

        const hit = findIntersection(passTrack, azsUnwrapped, headingUnwrapped);
        if (hit) {
          const hy = elToY(hit.elevation, chartTop, chartBottom);
          if (els.reticle) {
            els.reticle.style.transform = `translate(${cx - w / 2}px, ${hy - h / 2}px)`;
          }
          if (els.aimTime) {
            const timeLabel = hit.time.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false });
            els.aimTime.textContent = `この方向 → ${timeLabel} ごろ`;
            els.aimTime.classList.add('--show');
            els.aimTime.style.transform = `translate(calc(-50% + ${cx - w / 2}px), ${hy - h / 2 + 46}px)`;
          }
        } else if (els.aimTime) {
          els.aimTime.classList.remove('--show');
        }
      } else if (els.aimTime) {
        els.aimTime.classList.remove('--show');
      }
    } else if (els.aimTime) {
      els.aimTime.classList.remove('--show');
    }

    if (!lookAngles) {
      els.guideText.textContent = '⚠️ 軌道計算エラーが発生しました';
      if (els.reticle) els.reticle.classList.remove('--locked');
      return;
    }

    const targetAzimuth = lookAngles.azimuth;
    const targetElevation = lookAngles.elevation;
    if (els.tgtAz) els.tgtAz.textContent = targetAzimuth.toFixed(0) + '°';
    if (els.tgtEl) els.tgtEl.textContent = targetElevation.toFixed(0) + '°';

    const isVisible = targetElevation > 0;
    if (!isVisible) {
      const dir = (typeof ObserverManager !== 'undefined') ? ObserverManager.getCompassDirection(targetAzimuth) : '';
      els.guideText.textContent = `地平線の下に隠れています(次回は【${dir}】方向)`;
      if (els.reticle) els.reticle.classList.remove('--locked');
      if (els.statusText) { els.statusText.textContent = '通過待ち'; els.statusText.style.color = 'var(--muted)'; }
      return;
    }

    const dir = (typeof ObserverManager !== 'undefined') ? ObserverManager.getCompassDirection(targetAzimuth) : '';
    els.guideText.textContent = `【${dir}】の空を見上げて下さい (仰角 ${targetElevation.toFixed(0)}°)`;

    // --- 現在の衛星の実位置を、固定グラフ上のマーカーとして描画 ---
    if (range) {
      const satAzUnwrapped = unwrapToRange(targetAzimuth, (range.min + range.max) / 2);
      if (satAzUnwrapped >= range.min && satAzUnwrapped <= range.max) {
        const sx = CHART_MARGIN_X + (satAzUnwrapped - range.min) / (range.max - range.min) * (w - CHART_MARGIN_X * 2);
        const sy = elToY(targetElevation, chartTop, chartBottom);
        drawGlowDot(ctx, sx, sy, 11, '0, 209, 255', 1);
      }
    }

    // --- LOCK ON判定: 実際にスマホが向いている方位・仰角が、衛星の現在位置に近いかどうか ---
    let diffAz = targetAzimuth - currentHeading;
    diffAz = (diffAz + 180 + 360) % 360 - 180;
    const diffEl = targetElevation - currentPitch;
    const isLocked = Math.abs(diffAz) <= TOLERANCE_DEG && Math.abs(diffEl) <= TOLERANCE_DEG;

    if (els.reticle) els.reticle.classList.toggle('--locked', isLocked);
    if (els.statusText) {
      if (isLocked) {
        els.statusText.textContent = 'LOCK ON (受信可能角)';
        els.statusText.style.color = 'var(--ok)';
      } else {
        els.statusText.textContent = 'ALIGNING (調整中)';
        els.statusText.style.color = 'var(--accent)';
      }
    }
  }

  /**
   * 画面上部の方位磁針テープを描く。軌道グラフと同じ方位角レンジ・同じazToXを共有するため、
   * こちらも画面上に固定表示され、現在方位を示す三角マーカーだけが左右に動く。
   */
  function drawCompassTape(ctx, w, range, azToX, y) {
    const dirs = [
      ['N', 0], ['NE', 45], ['E', 90], ['SE', 135],
      ['S', 180], ['SW', 225], ['W', 270], ['NW', 315],
      ['N', 360], ['N', -360]
    ];
    ctx.save();
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const [label, deg] of dirs) {
      if (deg < range.min - 10 || deg > range.max + 10) continue;
      const x = azToX(deg);
      ctx.fillStyle = 'rgba(200, 240, 255, 0.5)';
      ctx.fillRect(x - 0.75, y - 5, 1.5, 10);
      ctx.fillStyle = 'rgba(220, 245, 255, 0.85)';
      ctx.fillText(label, x, y - 12);
    }

    const headingUnwrapped = unwrapToRange(currentHeading, (range.min + range.max) / 2);
    if (headingUnwrapped >= range.min && headingUnwrapped <= range.max) {
      const cx = azToX(headingUnwrapped);
      ctx.fillStyle = 'var(--accent, #00d1ff)';
      ctx.beginPath();
      ctx.moveTo(cx, y + 10);
      ctx.lineTo(cx - 5, y + 2);
      ctx.lineTo(cx + 5, y + 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function drawGlowDot(ctx, x, y, r, rgb, opacity) {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 2.2);
    grad.addColorStop(0, `rgba(${rgb}, ${0.9 * opacity})`);
    grad.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.beginPath();
    ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, r * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${rgb}, ${opacity})`;
    ctx.fill();
  }

  return {
    requestCameraPermission: requestCameraPermission,
    requestOrientationPermission: requestOrientationPermission,
    attachStreamToVideo: attachStreamToVideo,
    stopCamera: stopCamera,
    update: update
  };
})();
