/* ==========================================================
   ar-mode.js — ARファインダーモード制御
   背面カメラ映像の上に、コンパス/ジャイロから計算した
   衛星のいる方向を重ねて表示する。

   方位角・仰角 → 画面座標の変換は、東西南北上のベクトルによる
   本格的な透視投影(ピンホールカメラモデル)で行う。単純な
   「方位角の差を横方向のpxに変換」という近似は、天頂(仰角90°)
   付近で方位角自体が定義不能に近づくため破綻し、天頂を向けた
   瞬間に軌道が消えるという不具合の原因になっていた。
   ========================================================== */

const ARMode = (function() {
  let stream = null;
  // デバイスの姿勢(生のオイラー角)と画面の向きから、カメラの3軸ベクトルを毎フレーム計算する。
  // 旧実装は「方位角＋仰角(beta-90)」だけを使い傾き(gamma)を無視していたため、端末を傾けると
  // 軌道が一緒にズレて動き、天頂付近でジンバルロックして急に消える不具合があった。
  let orient = { alpha: 0, beta: 90, gamma: 0, has: false };
  let isAbsolute = false;      // deviceorientationabsolute (主にAndroid) で真北基準が取れているか
  let compassHeading = null;   // iOS webkitCompassHeading (真北基準の方位)
  let cam = { forward: { x: 0, y: 1, z: 0 }, right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } };
  let targetAzimuth = 0;
  let targetElevation = 0;

  const TOLERANCE_DEG = 15;    // 4エレ八木の指向性を踏まえた許容誤差
  const AIM_TIME_MAX_DEG = 20; // この角度以内に軌道があれば「今向けている場所の時刻」を表示
  const ASSUMED_FOV_H = 65;    // 背面カメラの想定水平画角(度)。実機で要キャリブレーション

  /**
   * センサーの向きを取得 (生のalpha/beta/gammaを保持し、投影時に回転行列で処理する)
   */
  function handleOrientation(event) {
    if (event.alpha === null && event.beta === null && event.gamma === null) return;
    orient.alpha = event.alpha || 0;
    orient.beta = (event.beta === null) ? 90 : event.beta;
    orient.gamma = event.gamma || 0;
    orient.has = true;
    if (typeof event.webkitCompassHeading === 'number' && !isNaN(event.webkitCompassHeading)) {
      compassHeading = event.webkitCompassHeading; // iOS: 真北基準の方位
    }
    if (event.absolute === true) isAbsolute = true;
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
  function startListening() {
    // 真北基準の絶対方位が取れる端末(主にAndroid)ではそちらを優先して登録
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', function(e) {
        isAbsolute = true;
        handleOrientation(e);
      }, true);
    }
    window.addEventListener('deviceorientation', handleOrientation, true);
  }

  function requestOrientationPermission() {
    return new Promise((resolve, reject) => {
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
          .then((state) => {
            if (state === 'granted') {
              startListening();
              resolve();
            } else {
              reject(new Error('センサーの利用が許可されませんでした'));
            }
          })
          .catch(reject);
      } else {
        // iOS以外は許可プロンプト不要でそのまま使える
        startListening();
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
   * 通過軌跡の中で、いまカメラが向いている方向(cam.forward)に
   * もっとも近い点を探す
   */
  function findNearestTrackPoint(passTrack) {
    const forward = cam.forward;
    let best = null, bestDot = -Infinity;
    for (let i = 0; i < passTrack.length; i++) {
      const v = toVector(passTrack[i].azimuth, passTrack[i].elevation);
      const d = dot(v, forward);
      if (d > bestDot) { bestDot = d; best = passTrack[i]; }
    }
    if (!best) return null;
    const angleDeg = Math.acos(Math.max(-1, Math.min(1, bestDot))) * 180 / Math.PI;
    return { point: best, angleDeg };
  }

  /**
   * デバイスの姿勢(alpha/beta/gamma)＋画面の向き → カメラの前方/右/上ベクトル(ENU世界座標)
   * 生のオイラー角から回転行列を組み、背面カメラの実際の向きを正確に求める。
   * gamma(端末の傾き)も反映されるため、端末を傾けても軌道は空に貼り付いたまま、
   * 天頂付近でも破綻しない。
   */
  function computeCameraBasis() {
    const d2r = Math.PI / 180;
    const a = orient.alpha * d2r, b = orient.beta * d2r, g = orient.gamma * d2r;
    const cX = Math.cos(b), sX = Math.sin(b);
    const cY = Math.cos(g), sY = Math.sin(g);
    const cZ = Math.cos(a), sZ = Math.sin(a);
    // W3C DeviceOrientation の回転行列(ZXY順)。デバイス座標→世界座標(x=東, y=北, z=上)
    const R11 = cZ*cY - sZ*sX*sY, R12 = -cX*sZ, R13 = cZ*sY + cY*sZ*sX;
    const R21 = cY*sZ + cZ*sX*sY, R22 = cZ*cX,  R23 = sZ*sY - cZ*cY*sX;
    const R31 = -cX*sY,           R32 = sX,      R33 = cX*cY;
    const mul = (vx, vy, vz) => ({
      x: R11*vx + R12*vy + R13*vz,
      y: R21*vx + R22*vy + R23*vz,
      z: R31*vx + R32*vy + R33*vz
    });

    // 画面の回転(縦持ち/横持ち)を反映した「画面右/画面上」ベクトル(デバイス座標)
    const sAng = ((screen.orientation && typeof screen.orientation.angle === 'number')
      ? screen.orientation.angle : (window.orientation || 0)) * d2r;
    const ca = Math.cos(sAng), sa = Math.sin(sAng);

    // 背面カメラの前方 = デバイス -Z。画面右/上は画面回転を反映してデバイス平面上で回す。
    let forward = mul(0, 0, -1);
    let right = mul(ca, sa, 0);
    let up = mul(-sa, ca, 0);

    // 真北補正: 絶対方位が無く(iOS等)compassHeadingがある場合、ヨーを実測方位に合わせる
    if (!isAbsolute && compassHeading !== null) {
      const azRaw = Math.atan2(forward.x, forward.y) * 180 / Math.PI;
      const yawErr = (compassHeading - azRaw) * d2r;
      const c = Math.cos(yawErr), s = Math.sin(yawErr);
      const rotZ = (v) => ({ x: c*v.x + s*v.y, y: -s*v.x + c*v.y, z: v.z });
      forward = rotZ(forward); right = rotZ(right); up = rotZ(up);
    }
    return { forward: normalize(forward), right: normalize(right), up: normalize(up) };
  }

  /**
   * 方位角・仰角 → 画面座標への透視投影 (ピンホールカメラモデル)
   * カメラの実姿勢(cam)を基準にするので、端末を動かすと軌道は空に貼り付いたまま逆方向へ流れる。
   */
  function project(az, el, w, h) {
    const target = toVector(az, el);
    const fwdComp = dot(target, cam.forward);
    const rightComp = dot(target, cam.right);
    const upComp = dot(target, cam.up);

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

    // カメラの実姿勢を毎フレーム更新 (以降の project() が参照する)
    cam = computeCameraBasis();

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
        // 前方87°を超える(≒真横〜後方)点だけ線を切る。天頂通過そのものでは切らない。
        if (!pt.inFront) { penDown = false; continue; }
        if (!penDown) { ctx.moveTo(pt.x, pt.y); penDown = true; }
        else { ctx.lineTo(pt.x, pt.y); }
      }
      ctx.stroke();
      ctx.restore();

      // 通過点ドット (約1分間隔) + 数分おきに時刻ラベル (HH:MM)
      let lastDotMin = null;
      const now = Date.now();
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

        // 2分おきに時刻(時:分)ラベルを表示
        if (minFromNow % 2 === 0) {
          const label = p.time.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false });
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

      // --- いま向けている場所にもっとも近い軌道上の点 → その時刻を表示 ---
      const nearest = findNearestTrackPoint(passTrack);
      if (nearest && nearest.angleDeg <= AIM_TIME_MAX_DEG) {
        const pt = project(nearest.point.azimuth, nearest.point.elevation, w, h);
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

    // --- 現在位置の点を描画 (視野内=実位置 / 視野外=画面端ににじませる) ---
    const cur = project(targetAzimuth, targetElevation, w, h);
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
