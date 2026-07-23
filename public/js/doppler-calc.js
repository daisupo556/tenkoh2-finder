/* ==========================================================
   doppler-calc.js — ドップラー効果による受信周波数予測
   基準送信周波数: 435.860 MHz (TEN-KOH 2 CW Beacon)
   ========================================================== */

const DopplerCalc = (function() {
  const TX_FREQ_MHZ = 435.860;
  const LIGHT_SPEED_KM_S = 299792.458; // 光速 (km/s)

  /**
   * 観測地点における現在の予測受信周波数・シフト量を計算
   * @param {Object} satrec - satellite.js の satrec オブジェクト
   * @param {Object} observerCoords - { lat, lon, alt }
   * @param {Date} date - 計算対象日時
   * @returns {Object|null} 計算結果オブジェクト
   */
  function calculateDoppler(satrec, observerCoords, date = new Date()) {
    if (!satrec || !observerCoords) return null;

    try {
      // 1. 現時刻でのLook Angles (距離 r1)
      const look1 = SatelliteCalc.getLookAngles(satrec, observerCoords, date);
      if (!look1) return null;

      // 2. 1秒後のLook Angles (距離 r2) を計算して距離変化率 (km/s) を取得
      const t2 = new Date(date.getTime() + 1000);
      const look2 = SatelliteCalc.getLookAngles(satrec, observerCoords, t2);
      if (!look2) return null;

      // rangeRate (正なら遠ざかる、負なら近づく)
      const rangeRate = look2.range - look1.range;

      // 3. ドップラーシフト量の計算
      // fd = - f0 * (vr / c)
      const shiftMhz = -TX_FREQ_MHZ * (rangeRate / LIGHT_SPEED_KM_S);
      const shiftKhz = shiftMhz * 1000;
      const rxFreqMhz = TX_FREQ_MHZ + shiftMhz;

      // 接近・離反の判定
      let status = "STATIONARY"; // 静止・天頂付近
      if (rangeRate < -0.05) {
        status = "APPROACHING"; // 接近中 (周波数は上がる)
      } else if (rangeRate > 0.05) {
        status = "RECEDING";    // 遠ざかり中 (周波数は下がる)
      }

      return {
        txFreqMhz: TX_FREQ_MHZ,
        rxFreqMhz: rxFreqMhz,
        shiftKhz: shiftKhz,
        rangeRateKmS: rangeRate,
        status: status
      };
    } catch (e) {
      console.error("ドップラー計算中にエラーが発生しました", e);
      return null;
    }
  }

  return {
    calculateDoppler: calculateDoppler,
    TX_FREQ_MHZ: TX_FREQ_MHZ
  };
})();
