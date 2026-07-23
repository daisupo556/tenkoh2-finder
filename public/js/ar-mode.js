/* ==========================================================
   ar-mode.js — ARファインダーモード制御
   背面カメラ映像の上に、コンパス/ジャイロから計算した
   衛星のいる方向を重ねて表示する。
   ========================================================== */

const ARMode = (function() {
  let stream = null;
  let currentHeading = 0;  // 0-360, 真北基準の想定 (磁北からの偏角補正は未実装)
  let currentPitch = 0;    // 0=水平線, 90=天頂
  let targetAzimuth = 0;
  let targetElevation = 0;

  const TOLERANCE_DEG = 15;   // 4エレ八木の指向性を踏まえた許容誤差
  const ASSUMED_FOV_H = 65;   // 背面カメラの想定水平画角(度)。実機によって前後する概算値

  /**
   * センサーの向きを取得
   */
  function handleOrientation(event) {
    if (event.webkitCompassHeading !== undefined) {
      currentHeading = event.webkitCompassHeading;
    } else if (event.alpha !== null) {
      currentHeading = (360 - event.alpha) % 360;
    }

    if (event.beta !== null) {
      // beta: 0=画面上向きに水平, 90=画面を立てて構えた状態(=カメラは水平線を向く)
      // 実機検証の結果、90を基準に上下が逆だったため beta-90 に修正
      // (スマホを上に傾けるほど currentPitch が増える = 表示も正しく下に動く)
      currentPitch = event.beta - 90;
    }
  }

  /**
   * カメラ(背面)の映像取得を要求する
   */
  async function requestCameraPermission() {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    });
    return stream;
  }

  /**
   * モーションセンサーの利用を要求する (iOSは明示的な許可が必要)
   */
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
        // iOS以外は許可プロンプト不要でそのまま使える
        window.addEventListener('deviceorientation', handleOrientation, true);
        resolve();
      }
    });
  }

  /**
   * 取得済みのカメラ映像を<video>要素に接続する
   */
  function attachStreamToVideo(videoEl) {
    if (stream && videoEl) {
      videoEl.srcObject = stream;
    }
  }

  /**
   * カメラ映像を停止する (他画面に切り替えた際のバッテリー節約用)
   */
  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  // 画面外に出た点を追跡する際、これ以上離れた点は線を繋がず切る (角度)
  const MAX_TRACK_ANGLE = ASSUMED_FOV_H * 1.5;

  /**
   * 方位角・仰角 → 現在の向きを基準にした画面座標に変換
   */
  function project(az, el, w, h) {
    let diffAz = az - currentHeading;
    diffAz = (diffAz + 180 + 360) % 360 - 180;
    const diffEl = el - currentPitch;
    const fovV = ASSUMED_FOV_H * (h / w);
    const x = w / 2 + diffAz * (w / ASSUMED_FOV_H);
    const y = h / 2 - diffEl * (h / fovV);
    const withinFov = Math.abs(diffAz) <= ASSUMED_FOV_H / 2 && Math.abs(diffEl) <= fovV / 2;
    return { x, y, diffAz, diffEl, withinFov };
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

    if (!hasObserverCoords) {
      els.guideText.textContent = '📍 位置情報を取得できていません';
      if (els.reticle) els.reticle.classList.remove('--locked');
      return;
    }
    if (!hasSatrec) {
      els.guideText.textContent = '🛰️ TLE衛星データを取得中...';
      if (els.reticle) els.reticle.classList.remove('--locked');
      return;
    }

    // --- 軌道ライン + 時刻ドットの描画 ---
    if (passTrack && passTrack.length >= 2) {
      const now = Date.now();

      // 実カメラ映像の上でも視認できるよう、太め+グロー付きで描画
      ctx.save();
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(86, 214, 255, 0.9)';
      ctx.shadowColor = 'rgba(86, 214, 255, 0.9)';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      let penDown = false;
      for (let i = 0; i < passTrack.length; i++) {
        const pt = project(passTrack[i].azimuth, passTrack[i].elevation, w, h);
        const tooFar = Math.abs(pt.diffAz) > MAX_TRACK_ANGLE || Math.abs(pt.diffEl) > MAX_TRACK_ANGLE;
        if (tooFar) { penDown = false; continue; }
        if (!penDown) { ctx.moveTo(pt.x, pt.y); penDown = true; }
        else { ctx.lineTo(pt.x, pt.y); }
      }
      ctx.stroke();
      ctx.restore();

      // 通過点ドット (約1分間隔) + 数分おきに経過時刻ラベル
      let lastDotMin = null;
      passTrack.forEach((p) => {
        const minFromNow = Math.round((p.time.getTime() - now) / 60000);
        if (lastDotMin !== null && minFromNow === lastDotMin) return;
        lastDotMin = minFromNow;
        const pt = project(p.azimuth, p.elevation, w, h);
        if (!pt.withinFov) return;

        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(10, 18, 24, 0.85)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(86, 214, 255, 0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();

        // 2分おきに「+N分」ラベルを表示 (0=現在時刻は現在位置マーカー側に任せて省く)
        if (minFromNow % 2 === 0 && minFromNow !== 0) {
          const label = (minFromNow > 0 ? '+' : '') + minFromNow + '分';
          ctx.font = 'bold 13px system-ui, sans-serif';
          const tw = ctx.measureText(label).width;
          const lx = pt.x + 10, ly = pt.y - 10;
          ctx.fillStyle = 'rgba(10, 18, 24, 0.75)';
          ctx.fillRect(lx - 3, ly - 13, tw + 6, 17);
          ctx.fillStyle = 'rgba(200, 240, 255, 0.95)';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, lx, ly - 4);
        }
      });
    }

    if (!lookAngles) {
      els.guideText.textContent = '⚠️ 軌道計算エラーが発生しました';
      if (els.reticle) els.reticle.classList.remove('--locked');
      return;
    }

    targetAzimuth = lookAngles.azimuth;
    targetElevation = lookAngles.elevation;
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

    // --- 現在位置の点を描画 (視野内=実位置 / 視野外=画面端ににじませる) ---
    const cur = project(targetAzimuth, targetElevation, w, h);
    const isLocked = Math.abs(cur.diffAz) <= TOLERANCE_DEG && Math.abs(cur.diffEl) <= TOLERANCE_DEG;
    const dotColor = isLocked ? '34, 197, 94' : '0, 209, 255'; // ok緑 / accentシアン (RGB)

    if (cur.withinFov) {
      drawGlowDot(ctx, cur.x, cur.y, 12, dotColor, 1);
    } else {
      // 画面中心から現在位置方向への直線と、画面端(少し内側)との交点を求めて滲ませる
      const margin = 26;
      const cx = w / 2, cy = h / 2;
      const dx = cur.x - cx, dy = cur.y - cy;
      const scaleX = dx !== 0 ? (w / 2 - margin) / Math.abs(dx) : Infinity;
      const scaleY = dy !== 0 ? (h / 2 - margin) / Math.abs(dy) : Infinity;
      const scale = Math.max(0, Math.min(scaleX, scaleY));
      const ex = cx + dx * scale, ey = cy + dy * scale;
      drawGlowDot(ctx, ex, ey, 16, dotColor, 0.55);
    }

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
   * にじみ(グロー)付きの点を描画する
   */
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
