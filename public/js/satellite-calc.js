/* ==========================================================
   satellite-calc.js — 衛星軌道およびLook Anglesの計算
   ========================================================== */

const SatelliteCalc = (function() {

  /**
   * 観測者から見た衛星の Look Angles (方位角, 仰角, 距離) を計算する
   * @param {Object} satrec - satellite.js の satrec オブジェクト
   * @param {Object} observer - { lat, lon, alt } (alt はキロメートル単位)
   * @param {Date} date - 計算対象の日時
   * @returns {Object|null} - { azimuth, elevation, range } (角度は度数法, 距離はkm)
   */
  function getLookAngles(satrec, observer, date = new Date()) {
    if (!satrec || !observer) return null;

    try {
      // 1. 衛星の ECI (Earth-Centered Inertial) 座標系での位置を計算
      const positionAndVelocity = satellite.propagate(satrec, date);
      const positionEci = positionAndVelocity.position;
      
      if (!positionEci) {
        return null;
      }

      // 2. 恒星時 (GMST) の取得
      const gmst = satellite.gstime(date);

      // 3. ECI 座標から ECF (Earth-Centered, Earth-Fixed) 座標系に変換
      const positionEcf = satellite.eciToEcf(positionEci, gmst);

      // 4. 観測者の Geodetic 座標を作成 (緯度経度をラジアンに変換)
      const observerGeodetic = {
        latitude: satellite.degreesToRadians(observer.lat),
        longitude: satellite.degreesToRadians(observer.lon),
        height: observer.alt // キロメートル単位
      };

      // 5. Look Angles (方位角, 仰角, 距離) を計算
      const lookAngles = satellite.ecfToLookAngles(observerGeodetic, positionEcf);

      // 6. ラジアンから度数法へ変換
      const azimuthDeg = satellite.radiansToDegrees(lookAngles.azimuth);
      const elevationDeg = satellite.radiansToDegrees(lookAngles.elevation);

      return {
        azimuth: (azimuthDeg + 360) % 360, // 0-360度に正規化
        elevation: elevationDeg,
        range: lookAngles.rangeSat
      };
    } catch (e) {
      console.error("Look Anglesの計算中にエラーが発生しました", e);
      return null;
    }
  }

  return {
    getLookAngles: getLookAngles
  };
})();
