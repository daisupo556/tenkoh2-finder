/* ==========================================================
   observer.js — 観測者位置の設定・管理
   ========================================================== */

const ObserverManager = (function() {
  // デフォルト位置: 東京 (日本大学付近を想定)
  const DEFAULT_LAT = 35.6812;
  const DEFAULT_LON = 139.7671;
  const DEFAULT_ALT = 0.05; // 50m (キロメートル単位)

  let observerCoords = {
    lat: DEFAULT_LAT,
    lon: DEFAULT_LON,
    alt: DEFAULT_ALT
  };

  // 16方位の定義
  const COMPASS_DIRECTIONS = [
    "北", "北北東", "北東", "東北東",
    "東", "東南東", "南東", "南南東",
    "南", "南南西", "南西", "西南西",
    "西", "西北西", "北西", "北北西"
  ];

  // ローカルストレージから読み込み
  function loadFromStorage() {
    try {
      const stored = localStorage.getItem('tenkoh2_observer');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (typeof parsed.lat === 'number' && typeof parsed.lon === 'number') {
          observerCoords.lat = parsed.lat;
          observerCoords.lon = parsed.lon;
          observerCoords.alt = typeof parsed.alt === 'number' ? parsed.alt : DEFAULT_ALT;
        }
      }
    } catch (e) {
      console.warn("LocalStorageからの観測者位置読み込みに失敗しました", e);
    }
  }

  // ローカルストレージに保存
  function saveToStorage() {
    try {
      localStorage.setItem('tenkoh2_observer', JSON.stringify(observerCoords));
    } catch (e) {
      console.error("LocalStorageへの保存に失敗しました", e);
    }
  }

  // 位置の更新
  function setLocation(lat, lon, alt = 0.05) {
    observerCoords.lat = Math.max(-90, Math.min(90, lat));
    observerCoords.lon = Math.max(-180, Math.min(180, lon));
    observerCoords.alt = Math.max(0, alt); // キロメートル
    saveToStorage();
    
    // イベントを発火して地球儀や計算処理に通知
    const event = new CustomEvent('observerchange', { detail: observerCoords });
    window.dispatchEvent(event);
  }

  // 角度（度数法）から16方位の文字列を取得する
  function getCompassDirection(deg) {
    let normalized = (deg % 360 + 360) % 360;
    const index = Math.round(normalized / 22.5) % 16;
    return COMPASS_DIRECTIONS[index];
  }

  // UIの設定
  function initUI() {
    loadFromStorage();

    const inputLat = document.getElementById('obs-lat');
    const inputLon = document.getElementById('obs-lon');
    const btnGeolocate = document.getElementById('btn-geolocate');

    // UI初期値セット
    if (inputLat && inputLon) {
      inputLat.value = observerCoords.lat.toFixed(4);
      inputLon.value = observerCoords.lon.toFixed(4);

      // 手入力変更イベント
      const onInputChange = () => {
        const lat = parseFloat(inputLat.value);
        const lon = parseFloat(inputLon.value);
        if (!isNaN(lat) && !isNaN(lon)) {
          setLocation(lat, lon);
        }
      };

      inputLat.addEventListener('change', onInputChange);
      inputLon.addEventListener('change', onInputChange);
    }

    // Geolocation API ボタン
    if (btnGeolocate) {
      btnGeolocate.addEventListener('click', () => {
        btnGeolocate.disabled = true;
        const originalText = btnGeolocate.textContent;
        btnGeolocate.textContent = "取得中...";

        if (!navigator.geolocation) {
          alert("お使いのブラウザは位置情報サービスに対応していません。");
          btnGeolocate.disabled = false;
          btnGeolocate.textContent = originalText;
          return;
        }

        navigator.geolocation.getCurrentPosition(
          (position) => {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;
            const alt = (position.coords.altitude || 50) / 1000; // メートルからキロメートルに変換

            if (inputLat && inputLon) {
              inputLat.value = lat.toFixed(4);
              inputLon.value = lon.toFixed(4);
            }
            
            setLocation(lat, lon, alt);
            btnGeolocate.disabled = false;
            btnGeolocate.textContent = originalText;
          },
          (error) => {
            console.error("位置情報の取得に失敗しました", error);
            alert("位置情報の取得に失敗しました。手動で入力してください。");
            btnGeolocate.disabled = false;
            btnGeolocate.textContent = originalText;
          },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
      });
    }

    // 初回のイベントを発火して初期位置を通知
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('observerchange', { detail: observerCoords }));
    }, 100);
  }

  return {
    init: initUI,
    getCoords: () => ({ ...observerCoords }),
    getCompassDirection: getCompassDirection
  };
})();
