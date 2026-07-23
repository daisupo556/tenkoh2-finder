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
      // 上を向けるほど beta は 90 から離れていくため、90を基準に仰角へ変換する
      currentPitch = 90 - event.beta;
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

  /**
   * 毎フレームのAR表示更新
   * @param {Object|null} lookAngles - { azimuth, elevation }
   * @param {boolean} hasSatrec
   * @param {boolean} hasObserverCoords
   * @param {Object} els - 関連DOM要素一式
   */
  function update(lookAngles, hasSatrec, hasObserverCoords, els) {
    if (!hasObserverCoords) {
      els.guideText.textContent = '📍 位置情報を取得できていません';
      hideMarkerAndArrows(els);
      return;
    }
    if (!hasSatrec) {
      els.guideText.textContent = '🛰️ TLE衛星データを取得中...';
      hideMarkerAndArrows(els);
      return;
    }
    if (!lookAngles) {
      els.guideText.textContent = '⚠️ 軌道計算エラーが発生しました';
      hideMarkerAndArrows(els);
      return;
    }

    targetAzimuth = lookAngles.azimuth;
    targetElevation = lookAngles.elevation;

    if (els.tgtAz) els.tgtAz.textContent = targetAzimuth.toFixed(0) + '°';
    if (els.tgtEl) els.tgtEl.textContent = targetElevation.toFixed(0) + '°';

    if (targetElevation <= 0) {
      els.guideText.textContent = '地平線の下に隠れています';
    } else {
      const dir = (typeof ObserverManager !== 'undefined')
        ? ObserverManager.getCompassDirection(targetAzimuth)
        : '';
      els.guideText.textContent = `【${dir}】の空を見上げて下さい (仰角 ${targetElevation.toFixed(0)}°)`;
    }

    // 方位差 (-180〜+180に正規化)
    let diffAz = targetAzimuth - currentHeading;
    diffAz = (diffAz + 180 + 360) % 360 - 180;
    const diffEl = targetElevation - currentPitch;

    const w = window.innerWidth || document.documentElement.clientWidth;
    const h = window.innerHeight || document.documentElement.clientHeight;
    const fovV = ASSUMED_FOV_H * (h / w);
    const pxPerDegX = w / ASSUMED_FOV_H;
    const pxPerDegY = h / fovV;

    const withinH = Math.abs(diffAz) <= ASSUMED_FOV_H / 2;
    const withinV = Math.abs(diffEl) <= fovV / 2;

    [els.arrowUp, els.arrowDown, els.arrowLeft, els.arrowRight].forEach((a) => {
      if (a) a.classList.remove('--show');
    });

    if (withinH && withinV) {
      const offsetX = diffAz * pxPerDegX;
      const offsetY = -diffEl * pxPerDegY;
      if (els.marker) {
        els.marker.style.display = 'block';
        els.marker.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px))`;
      }
    } else {
      if (els.marker) els.marker.style.display = 'none';
      if (diffAz > ASSUMED_FOV_H / 2 && els.arrowRight) els.arrowRight.classList.add('--show');
      if (diffAz < -ASSUMED_FOV_H / 2 && els.arrowLeft) els.arrowLeft.classList.add('--show');
      if (diffEl > fovV / 2 && els.arrowUp) els.arrowUp.classList.add('--show');
      if (diffEl < -fovV / 2 && els.arrowDown) els.arrowDown.classList.add('--show');
    }

    const isLocked = Math.abs(diffAz) <= TOLERANCE_DEG && Math.abs(diffEl) <= TOLERANCE_DEG;
    if (els.reticle) els.reticle.classList.toggle('--locked', isLocked);
    if (els.marker) els.marker.classList.toggle('--locked', isLocked);
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

  function hideMarkerAndArrows(els) {
    if (els.marker) els.marker.style.display = 'none';
    [els.arrowUp, els.arrowDown, els.arrowLeft, els.arrowRight].forEach((a) => {
      if (a) a.classList.remove('--show');
    });
    if (els.reticle) els.reticle.classList.remove('--locked');
  }

  return {
    requestCameraPermission: requestCameraPermission,
    requestOrientationPermission: requestOrientationPermission,
    attachStreamToVideo: attachStreamToVideo,
    stopCamera: stopCamera,
    update: update
  };
})();
