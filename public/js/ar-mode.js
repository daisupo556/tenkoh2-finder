/* ==========================================================
   ar-mode.js — ARファインダーモード制御
   背面カメラ映像の上に、コンパス/ジャイロから計算した
   衛星のいる方向を重ねて表示する。

   方位角・仰角 → 画面座標の変換は、東西南北上のベクトルによる
   本格的な透視投影(ピンホールカメラモデル)で行う。単純な
   「方位角の差を横方向のpxに変換」という近似は天頂付近で破綻する。

   また、スマホの傾き(ロール/gamma)を無視すると、まっすぐ構えて
   いるつもりでも実際は少し傾いているため軌道線が実際の空とズレて
   見える("ドリフトする")原因になるため、ロール補正とセンサー値の
   平滑化(急なブレを抑える)を行っている。
   ========================================================== */

const ARMode = (function() {
  let stream = null;

  // 平滑化後の値 (実際に描画に使う)
  let currentHeading = 0;  // 0-360, 真北基準の想定 (磁北からの偏角補正は未実装)
  let currentPitch = 0;    // -90=真下, 0=水平線, 90=天頂
  let currentRoll = 0;     // スマホの傾き(左右のロール)
  let hasOrientationData = false;

  let targetAzimuth = 0;
  let targetElevation = 0;

  const TOLERANCE_DEG = 15;    // 4エレ八木の指向性を踏まえた許容誤差
  const AIM_TIME_MAX_DEG = 20; // この角度以内に軌道があれば「今向けている場所の時刻」を表示
  const ASSUMED_FOV_H = 65;    // 背面カメラの想定水平画角(度)。実機によって前後する概算値
  const SMOOTH_FACTOR = 0.25;  // センサー値の平滑化係数 (小さいほど滑らかだが反応が遅くなる)

  // スマホを垂直に構えた姿勢(beta≈90°)は、alpha/beta/gammaという3つの角度で
  // 向きを表す方式の数学的な特異点に近く、特にgamma(ロール)が実際には
  // ほとんど動いていなくても瞬間的に大きく暴れることがある(ジンバルロックに近い現象)。
  // これがそのまま回転補正に使われると、画面全体が一瞬でぐるっと回転して見える。
  // 1フレームでの変化量が非現実的に大きい場合はセンサーノイズとみなして無視する。
  const MAX_JUMP_PER_EVENT_DEG = 20;

  /**
   * 角度(0-360, 周回あり)の平滑化。359°→1°のような跨ぎを正しく扱う
   */
  function smoothAngle(current, target, factor) {
    let diff = target - current;
    diff = (diff + 180 + 360) % 360 - 180;
    return (current + diff * factor + 360) % 360;
  }

  /**
   * センサーの向きを取得
   */
  function handleOrientation(event) {
    let rawHeading = currentHeading;
    if (event.webkitCompassHeading !== undefined) {
      rawHeading = event.webkitCompassHeading;
    } else if (event.alpha !== null) {
      rawHeading = (360 - event.alpha) % 360;
    }
    // beta: 0=画面上向きに水平, 90=画面を立てて構えた状態(=カメラは水平線を向く)
    // 実機検証の結果、90を基準に上下が逆だったため beta-90 に変換
    const rawPitch = (event.beta !== null) ? event.beta - 90 : currentPitch;
    // gamma: スマホの左右の傾き(ロール)。構えた時にまっすぐでないと軌道全体がズレて見えるため補正に使う
    const rawRoll = (event.gamma !== null) ? event.gamma : currentRoll;

    if (!hasOrientationData) {
      currentHeading = rawHeading;
      currentPitch = rawPitch;
      currentRoll = rawRoll;
      hasOrientationData = true;
      return;
    }

    let headingDiff = rawHeading - currentHeading;
    headingDiff = (headingDiff + 180 + 360) % 360 - 180;
    if (Math.abs(headingDiff) < MAX_JUMP_PER_EVENT_DEG) {
      currentHeading = smoothAngle(currentHeading, rawHeading, SMOOTH_FACTOR);
    }
    if (Math.abs(rawPitch - currentPitch) < MAX_JUMP_PER_EVENT_DEG) {
      currentPitch += (rawPitch - currentPitch) * SMOOTH_FACTOR;
    }
    if (Math.abs(rawRoll - currentRoll) < MAX_JUMP_PER_EVENT_DEG) {
      currentRoll += (rawRoll - currentRoll) * SMOOTH_FACTOR;
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

  // ---- ベクトル演算ヘルパー ----
  function toVector(azDeg, elDeg) {
    const az = azDeg * Math.PI / 180, el = elDeg * Math.PI / 180;
    return {
      x: Math.cos(el) * Math.sin(az), // 東
      y: Math.cos(el) * Math.cos(az), // 北
      z: Math.sin(el)                 // 上
    };
  }
  function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function cross(a, b) {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  }
  function normalize(v) {
    const m = Math.sqrt(dot(v, v));
    if (!m) return { x: 0, y: 0, z: 0 };
    return { x: v.x / m, y: v.y / m, z: v.z / m };
  }

  /**
   * 現在のセンサー値から、カメラのforward/right/up基底ベクトルを作る。
   * ロール(gamma)分だけforward軸まわりにright/upを回転させることで、
   * 「スマホがまっすぐ構えられていない」ズレを補正する。
   */
  function computeCameraBasis() {
    const forward = toVector(currentHeading, currentPitch);
    const worldUp = { x: 0, y: 0, z: 1 };

    let right = normalize(cross(forward, worldUp));
    if (right.x === 0 && right.y === 0 && right.z === 0) {
      // forwardがほぼ真上/真下向きだとworldUpと平行になり破綻するため、
      // その場合はコンパス方位から直接「右」ベクトルを作る
      const hRad = currentHeading * Math.PI / 180;
      right = { x: Math.cos(hRad), y: -Math.sin(hRad), z: 0 };
    }
    const up = cross(right, forward);

    const rollRad = -currentRoll * Math.PI / 180;
    const cosR = Math.cos(rollRad), sinR = Math.sin(rollRad);
    const rightR = {
      x: right.x * cosR + up.x * sinR,
      y: right.y * cosR + up.y * sinR,
      z: right.z * cosR + up.z * sinR
    };
    const upR = {
      x: up.x * cosR - right.x * sinR,
      y: up.y * cosR - right.y * sinR,
      z: up.z * cosR - right.z * sinR
    };
    return { forward, right: rightR, up: upR };
  }

  /**
   * 方位角・仰角 → 画面座標への透視投影 (ピンホールカメラモデル)
   */
  function project(az, el, basis, w, h) {
    const target = toVector(az, el);
    const fwdComp = dot(target, basis.forward);
    const rightComp = dot(target, basis.right);
    const upComp = dot(target, basis.up);

    const focalPx = (w / 2) / Math.tan((ASSUMED_FOV_H * Math.PI / 180) / 2);
    const angleFromCenterDeg = Math.acos(Math.max(-1, Math.min(1, fwdComp))) * 180 / Math.PI;

    const inFront = fwdComp > 0.05; // 前方おおよそ87°以内
    const x = inFront ? w / 2 + focalPx * (rightComp / fwdComp) : null;
    const y = inFront ? h / 2 - focalPx * (upComp / fwdComp) : null;
    const withinFov = inFront && x >= 0 && x <= w && y >= 0 && y <= h;

    // 画面のどちら方向にあるか (視野外インジケーター配置用。前方/後方に関わらず常に有効)
    const viewAngle = Math.atan2(upComp, rightComp);

    return { x, y, inFront, withinFov, angleFromCenterDeg, viewAngle };
  }

  /**
   * 通過軌跡の中で、いま向けている方向にもっとも近い点を探す
   */
  function findNearestTrackPoint(passTrack, basis) {
    let best = null, bestDot = -Infinity;
    for (let i = 0; i < passTrack.length; i++) {
      const v = toVector(passTrack[i].azimuth, passTrack[i].elevation);
      const d = dot(v, basis.forward);
      if (d > bestDot) { bestDot = d; best = passTrack[i]; }
    }
    if (!best) return null;
    const angleDeg = Math.acos(Math.max(-1, Math.min(1, bestDot))) * 180 / Math.PI;
    return { point: best, angleDeg };
  }

  /**
   * 画面上部の方位磁針テープを描く (現在向いている方位を中心に、周辺の方位を並べる)
   */
  function drawCompassTape(ctx, w, topOffset) {
    const dirs = [
      ['N', 0], ['NE', 45], ['E', 90], ['SE', 135],
      ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]
    ];
    const y = topOffset + 34;
    const pxPerDeg = w / ASSUMED_FOV_H;

    ctx.save();
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const [label, deg] of dirs) {
      for (const wrap of [-360, 0, 360]) {
        let diff = (deg + wrap) - currentHeading;
        if (Math.abs(diff) > ASSUMED_FOV_H) continue;
        const x = w / 2 + diff * pxPerDeg;
        ctx.fillStyle = 'rgba(200, 240, 255, 0.55)';
        ctx.fillRect(x - 0.75, y - 6, 1.5, 12);
        ctx.fillStyle = 'rgba(220, 245, 255, 0.9)';
        ctx.fillText(label, x, y - 14);
      }
    }

    // 中心の現在方位マーカー
    ctx.fillStyle = 'var(--accent, #00d1ff)';
    ctx.beginPath();
    ctx.moveTo(w / 2, y + 12);
    ctx.lineTo(w / 2 - 6, y + 2);
    ctx.lineTo(w / 2 + 6, y + 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.fillText(Math.round(currentHeading) + '°', w / 2, y - 26);
    ctx.restore();
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

    const basis = computeCameraBasis();
    const topInfoEl = els.guideText && els.guideText.closest('.ar-top-info');
    const topOffset = topInfoEl ? topInfoEl.getBoundingClientRect().bottom : 90;
    drawCompassTape(ctx, w, topOffset);

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

    // --- 軌道ライン + 通過点ドットの描画 ---
    if (passTrack && passTrack.length >= 2) {
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
        const pt = project(passTrack[i].azimuth, passTrack[i].elevation, basis, w, h);
        if (!pt.inFront) { penDown = false; continue; }
        if (!penDown) { ctx.moveTo(pt.x, pt.y); penDown = true; }
        else { ctx.lineTo(pt.x, pt.y); }
      }
      ctx.stroke();
      ctx.restore();

      let lastDotMin = null;
      const nowMs = Date.now();
      passTrack.forEach((p) => {
        const minFromNow = Math.round((p.time.getTime() - nowMs) / 60000);
        if (lastDotMin !== null && minFromNow === lastDotMin) return;
        lastDotMin = minFromNow;
        const pt = project(p.azimuth, p.elevation, basis, w, h);
        if (!pt.withinFov) return;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(10, 18, 24, 0.85)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(86, 214, 255, 0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
      });

      // いま向けている場所にもっとも近い軌道上の点 → その時刻を表示
      const nearest = findNearestTrackPoint(passTrack, basis);
      if (nearest && nearest.angleDeg <= AIM_TIME_MAX_DEG) {
        const pt = project(nearest.point.azimuth, nearest.point.elevation, basis, w, h);
        if (pt.withinFov) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 9, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }
        if (els.aimTime) {
          const timeLabel = nearest.point.time.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false });
          els.aimTime.textContent = `この方向 → ${timeLabel} ごろ`;
          els.aimTime.classList.add('--show');
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

    // --- 現在の衛星位置の点を描画 (視野内=実位置 / 視野外=画面端ににじませる) ---
    const cur = project(targetAzimuth, targetElevation, basis, w, h);
    const isLocked = cur.angleFromCenterDeg <= TOLERANCE_DEG;
    const dotColor = isLocked ? '34, 197, 94' : '0, 209, 255'; // ok緑 / accentシアン (RGB)

    if (cur.withinFov) {
      drawGlowDot(ctx, cur.x, cur.y, 12, dotColor, 1);
    } else {
      // 画面中心から見た方向角(viewAngle)を使って、画面端(少し内側)との交点を求めて滲ませる。
      // 透視投影の座標(x,y)は視野の反対側(後方)では発散するため使わず、角度だけを使う。
      const margin = 26;
      const halfW = w / 2 - margin, halfH = h / 2 - margin;
      const dirX = Math.cos(cur.viewAngle), dirY = -Math.sin(cur.viewAngle);
      const scaleX = dirX !== 0 ? halfW / Math.abs(dirX) : Infinity;
      const scaleY = dirY !== 0 ? halfH / Math.abs(dirY) : Infinity;
      const scale = Math.min(scaleX, scaleY);
      const ex = w / 2 + dirX * scale, ey = h / 2 + dirY * scale;
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
