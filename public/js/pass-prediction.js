/* ==========================================================
   pass-prediction.js — TEN-KOH 2 通過予測
   24時間先までを探索し、AOS/LOS/最大仰角を検出する。
   ========================================================== */

const PassPredictor = (function() {

  const SCAN_STEP_SEC  = 30;   // 探索の時間刻み（秒）
  const REFINE_ITER    = 12;   // 二分探索の反復回数
  const MIN_MAX_EL_DEG = 1;    // 通過と見なす最低の最大仰角

  let cachedPasses  = null;
  let cacheTime     = 0;
  let cacheObserver = null;
  const CACHE_TTL   = 120000;  // キャッシュ有効期間（2分）

  /**
   * 指定日時における仰角を返す（度数法）
   */
  function elevationAt(satrec, observer, date) {
    const look = SatelliteCalc.getLookAngles(satrec, observer, date);
    return look ? look.elevation : -999;
  }

  /**
   * 仰角がゼロを横切る正確な時刻を二分探索で求める
   * @param {number} dir - 1=AOS（上向き交差）, -1=LOS（下向き交差）
   */
  function refineCrossing(satrec, observer, tBefore, tAfter, dir) {
    let lo = tBefore.getTime();
    let hi = tAfter.getTime();

    for (let i = 0; i < REFINE_ITER; i++) {
      const mid = (lo + hi) / 2;
      const el = elevationAt(satrec, observer, new Date(mid));
      if ((dir > 0 && el < 0) || (dir < 0 && el > 0)) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return new Date((lo + hi) / 2);
  }

  /**
   * 24時間先までの通過を検出する
   * @returns {Array} passes — 各要素: { aos, los, maxEl, maxElTime, aosAz, losAz, aosDir, losDir, duration }
   */
  function findPasses(satrec, observer, hoursAhead) {
    if (!satrec || !observer) return [];

    hoursAhead = hoursAhead || 24;

    // キャッシュチェック
    const nowMs = Date.now();
    if (cachedPasses && cacheObserver &&
        cacheObserver.lat === observer.lat &&
        cacheObserver.lon === observer.lon &&
        (nowMs - cacheTime) < CACHE_TTL) {
      return cachedPasses;
    }

    const passes = [];
    const nowDate = new Date();
    const endMs = nowDate.getTime() + hoursAhead * 3600000;
    const stepMs = SCAN_STEP_SEC * 1000;

    let prevEl = elevationAt(satrec, observer, nowDate);
    let inPass = prevEl > 0;
    let passStart = inPass ? nowDate : null;
    let maxEl = inPass ? prevEl : -999;
    let maxElTime = inPass ? nowDate : null;

    for (let ms = nowDate.getTime() + stepMs; ms <= endMs; ms += stepMs) {
      const t = new Date(ms);
      const el = elevationAt(satrec, observer, t);

      // AOS 検出: 仰角が負→正に変わった
      if (prevEl <= 0 && el > 0) {
        passStart = refineCrossing(satrec, observer, new Date(ms - stepMs), t, 1);
        inPass = true;
        maxEl = el;
        maxElTime = t;
      }

      // 通過中: 最大仰角を追跡
      if (inPass && el > maxEl) {
        maxEl = el;
        maxElTime = t;
      }

      // LOS 検出: 仰角が正→負に変わった
      if (prevEl > 0 && el <= 0) {
        const los = refineCrossing(satrec, observer, new Date(ms - stepMs), t, -1);

        if (maxEl >= MIN_MAX_EL_DEG && passStart) {
          const aosLook = SatelliteCalc.getLookAngles(satrec, observer, passStart);
          const losLook = SatelliteCalc.getLookAngles(satrec, observer, los);

          passes.push({
            aos: passStart,
            los: los,
            maxEl: maxEl,
            maxElTime: maxElTime,
            aosAz: aosLook ? aosLook.azimuth : 0,
            losAz: losLook ? losLook.azimuth : 0,
            aosDir: aosLook ? ObserverManager.getCompassDirection(aosLook.azimuth) : "---",
            losDir: losLook ? ObserverManager.getCompassDirection(losLook.azimuth) : "---",
            duration: (los.getTime() - passStart.getTime()) / 1000
          });
        }

        inPass = false;
        passStart = null;
        maxEl = -999;
      }

      prevEl = el;
    }

    // キャッシュ更新
    cachedPasses = passes;
    cacheTime = nowMs;
    cacheObserver = { lat: observer.lat, lon: observer.lon };

    return passes;
  }

  /**
   * キャッシュを無効化する（観測者位置が変わった時）
   */
  function invalidateCache() {
    cachedPasses = null;
    cacheTime = 0;
    cacheObserver = null;
  }

  /**
   * 特定の通過の軌跡データ（スカイプロット用）を生成する
   * @returns {Array} points — 各要素: { azimuth, elevation, time }
   */
  function getPassTrack(satrec, observer, pass) {
    if (!satrec || !observer || !pass) return [];

    const points = [];
    const startMs = pass.aos.getTime();
    const endMs = pass.los.getTime();
    const stepMs = Math.max(2000, (endMs - startMs) / 60); // 最大60ポイント

    for (let ms = startMs; ms <= endMs; ms += stepMs) {
      const t = new Date(ms);
      const look = SatelliteCalc.getLookAngles(satrec, observer, t);
      if (look && look.elevation >= 0) {
        points.push({
          azimuth: look.azimuth,
          elevation: look.elevation,
          time: t
        });
      }
    }

    // 最終点を確実に含める
    const lastLook = SatelliteCalc.getLookAngles(satrec, observer, pass.los);
    if (lastLook) {
      points.push({
        azimuth: lastLook.azimuth,
        elevation: Math.max(0, lastLook.elevation),
        time: pass.los
      });
    }

    return points;
  }

  /**
   * 時刻をJSTフォーマットで表示する
   */
  function formatTimeJST(date) {
    return date.toLocaleTimeString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'Asia/Tokyo'
    });
  }

  /**
   * 秒数を「○分○秒」形式にフォーマットする
   */
  function formatCountdown(sec) {
    if (sec < 0) return "通過中";
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return h + "時間" + m + "分";
    if (m > 0) return m + "分" + String(s).padStart(2, '0') + "秒";
    return s + "秒";
  }

  // 観測者変更時にキャッシュクリア
  window.addEventListener('observerchange', invalidateCache);

  return {
    findPasses: findPasses,
    getPassTrack: getPassTrack,
    formatTimeJST: formatTimeJST,
    formatCountdown: formatCountdown,
    invalidateCache: invalidateCache
  };
})();
