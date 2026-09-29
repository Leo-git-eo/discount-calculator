(() => {
  "use strict";

  // ホーム画面追加時、CSSの100dvhが実際の画面高さとズレることがあるため、
  // JSで取得した実寸を --app-height としてCSS側に渡す
  function setAppHeight() {
    document.documentElement.style.setProperty("--app-height", window.innerHeight + "px");
  }
  setAppHeight();
  window.addEventListener("resize", setAppHeight);
  window.addEventListener("orientationchange", setAppHeight);

  const STORAGE_KEY = "discount-calc-settings-v2";
  const DIGIT_CAP = 3;

  const ROUNDING_MODES = [
    { id: "floor", name: "切り捨て" },
    { id: "ceil", name: "切り上げ" },
    { id: "round", name: "四捨五入" },
  ];

  const ROUND_UNITS = [1, 10];

  const KEYPAD_ORDERS = {
    phone: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"],
    calc: ["7", "8", "9", "4", "5", "6", "1", "2", "3", "clear", "0", "back"],
  };

  const DISPLAY_STYLES = [
    { id: "tiles", name: "カード" },
    { id: "circles", name: "丸" },
  ];

  function defaultSettings() {
    return {
      rate1: 20,
      rate2: 30,
      rate3: 50,
      roundMode: "floor",
      roundUnit: 1,
      keypadOrder: "phone",
      displayStyle: "tiles",
      showYenSign: false,
      keepAwake: true,
    };
  }

  function loadSettings() {
    const fallback = defaultSettings();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return Object.assign({}, fallback, parsed);
    } catch (e) {
      return fallback;
    }
  }

  let settings = loadSettings();

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function applyRounding(value, mode, unit) {
    const scaled = value / unit;
    let rounded;
    if (mode === "ceil") rounded = Math.ceil(scaled);
    else if (mode === "round") rounded = Math.round(scaled);
    else rounded = Math.floor(scaled);
    return rounded * unit;
  }

  function computeDiscounted(price, rate, mode, unit) {
    const raw = price * (1 - rate / 100);
    return applyRounding(raw, mode, unit);
  }

  function formatYen(n) {
    const sign = settings.showYenSign ? "¥" : "";
    return sign + n.toLocaleString("ja-JP");
  }

  // ---------- Keep screen awake ----------

  const wakeLockSupported = "wakeLock" in navigator;
  let wakeLock = null;
  let wakeLockPending = false;

  // 画面が表示されている間だけ保持する（アプリを閉じる・切り替えるとOS側で自動解除されるので、戻った時に取り直す）
  async function updateWakeLock() {
    if (!wakeLockSupported) return;
    const want = settings.keepAwake && document.visibilityState === "visible";
    if (want && !wakeLock && !wakeLockPending) {
      wakeLockPending = true;
      try {
        const lock = await navigator.wakeLock.request("screen");
        lock.addEventListener("release", () => {
          if (wakeLock === lock) wakeLock = null;
        });
        wakeLock = lock;
        if (!settings.keepAwake) updateWakeLock();
      } catch (e) {
        wakeLock = null;
      } finally {
        wakeLockPending = false;
      }
    } else if (!want && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      lock.release().catch(() => {});
    }
  }

  document.addEventListener("visibilitychange", updateWakeLock);
  // 端末によっては画面操作がないと取得できないため、タップした時にも取り直す
  document.addEventListener("pointerdown", updateWakeLock);

  // ---------- Keypad order ----------

  function applyKeypadOrder() {
    const order = KEYPAD_ORDERS[settings.keypadOrder] || KEYPAD_ORDERS.phone;
    const keypad = document.querySelector('[data-role="keypad"]');
    order.forEach((key, idx) => {
      const btn = keypad.querySelector(`[data-key="${key}"]`);
      if (btn) btn.style.order = idx;
    });
  }

  // ---------- Calculator screen ----------

  const inputEl = document.querySelector('[data-role="input"]');
  const keypad = document.querySelector('[data-role="keypad"]');
  const tilesEl = document.querySelector('[data-role="tiles"]');
  const circlesEl = document.querySelector('[data-role="circles"]');

  let currentInput = "0";
  // 表示が"0"のまま何も入力していない状態か。true の間に押した数字（0でも）は
  // そのまま1桁目として記録する（2桁の商品を「0」から打ち始められるようにするため）
  let freshEntry = true;

  const tileRows = [1, 2, 3].map((i) => ({
    pctEl: tilesEl.querySelector(`[data-role="pct${i}"]`),
    valueEl: tilesEl.querySelector(`[data-role="value${i}"]`),
  }));

  const circleRows = [1, 2, 3].map((i) => ({
    itemEl: circlesEl.querySelector(`.circle-item[data-tier="${i}"]`),
    pctEl: circlesEl.querySelector(`[data-role="cpct${i}"]`),
    valueEl: circlesEl.querySelector(`[data-role="cvalue${i}"]`),
  }));

  function retainedPercents() {
    return [100 - settings.rate1, 100 - settings.rate2, 100 - settings.rate3];
  }

  // カード形式：2段目・3段目の枠の高さを、割引後に残る割合（＝金額の比率）に合わせる
  // 差が目で分かりやすいよう、比率をそのまま使わずしっかり強調する
  function updateTileRowRatio() {
    const retained = retainedPercents();
    const EXPONENT = 2;
    const w2 = Math.pow(retained[1], EXPONENT);
    const w3 = Math.pow(retained[2], EXPONENT);
    tilesEl.style.gridTemplateRows = `${w2}fr ${w3}fr`;
  }

  // 円形式：円の直径を、割引後に残る割合（＝金額の比率）に合わせて決める（入力金額では変化させない）
  // 20%は左上、30%はその右側（やや下寄り）、50%は20%と30%の下・やや左寄りに
  // 両方に軽く接するように配置する（手書きの配置案に合わせた）。
  // 円同士は重ねない（重ねると金額の文字数によっては隠れてしまうため）。中心同士の距離を
  // 「両方の半径の合計＋すき間」にすることで、サイズが変わっても必ず離れるようにする。
  // 最後に、実際に使える枠（テンキーを押し出さない範囲）に収まるよう全体を縮小する
  const CIRCLE_MIN_RATIO = 0.34; // 枠の幅に対する最小の円の直径
  const CIRCLE_MAX_RATIO = 0.52; // 枠の幅に対する最大の円の直径
  const CIRCLE_GAP = 6;

  function updateCircleSizes() {
    const containerW = circlesEl.clientWidth || Math.max(window.innerWidth - 32, 240);
    const containerH = circlesEl.clientHeight || 300;

    const retained = retainedPercents();
    const minR = Math.min(...retained);
    const maxR = Math.max(...retained);
    const span = maxR - minR || 1;
    const sizeMin = containerW * CIRCLE_MIN_RATIO;
    const sizeMax = containerW * CIRCLE_MAX_RATIO;
    const sizes = retained.map((r) => sizeMin + ((r - minR) / span) * (sizeMax - sizeMin));
    const radii = sizes.map((s) => s / 2);

    // 20%（円0）は左上、30%（円1）はその右（ほぼ真横、やや上寄り）
    const c0 = { x: radii[0], y: radii[0] };
    const dirX = 0.97, dirY = 0.12;
    const dirLen = Math.hypot(dirX, dirY);
    const dist01 = radii[0] + radii[1] + CIRCLE_GAP;
    const c1 = {
      x: c0.x + (dist01 * dirX) / dirLen,
      y: c0.y + (dist01 * dirY) / dirLen,
    };

    // 50%（円2）は円0・円1の下、ちょうど中央。どちらとも重ならない最小の高さに置く
    const midX = c0.x + (c1.x - c0.x) * 0.5;
    const minDist02 = radii[0] + radii[2] + CIRCLE_GAP;
    const minDist12 = radii[1] + radii[2] + CIRCLE_GAP;
    const dx0 = midX - c0.x;
    const dx1 = midX - c1.x;
    const y0 = c0.y + Math.sqrt(Math.max(minDist02 * minDist02 - dx0 * dx0, 0));
    const y1 = c1.y + Math.sqrt(Math.max(minDist12 * minDist12 - dx1 * dx1, 0));
    const c2 = { x: midX, y: Math.max(y0, y1) };

    const centers = [c0, c1, c2];

    // 実際に使える幅・高さに収まらない場合は、円の大きさごと縮小する（重なりが起きないように保つ）
    const right = Math.max(...centers.map((c, i) => c.x + radii[i]));
    const bottom = Math.max(...centers.map((c, i) => c.y + radii[i]));
    const scale = Math.min(containerW / right, containerH / bottom, 1);
    if (scale < 1) {
      centers.forEach((c) => { c.x *= scale; c.y *= scale; });
      for (let i = 0; i < 3; i++) { sizes[i] *= scale; radii[i] *= scale; }
    }

    circleRows.forEach((row, i) => {
      row.itemEl.style.width = sizes[i] + "px";
      row.itemEl.style.height = sizes[i] + "px";
      row.itemEl.style.left = (centers[i].x - radii[i]) + "px";
      row.itemEl.style.top = (centers[i].y - radii[i]) + "px";
      // 円が小さくなっても最低限読める大きさは保つ（50%引きの円が一番小さくなりやすいため）
      row.valueEl.style.fontSize = Math.max(22, Math.round(sizes[i] * 0.21)) + "px";
      row.pctEl.style.fontSize = Math.max(13, Math.round(sizes[i] * 0.11)) + "px";
    });
  }

  function updateLayoutRatios() {
    updateTileRowRatio();
    if (!circlesEl.hidden) updateCircleSizes();
  }

  keypad.addEventListener("click", (e) => {
    const btn = e.target.closest(".key");
    if (!btn) return;
    const key = btn.dataset.key;
    if (key === "clear") {
      currentInput = "0";
      freshEntry = true;
    } else if (key === "back") {
      if (currentInput.length > 1) {
        currentInput = currentInput.slice(0, -1);
      } else {
        currentInput = "0";
        freshEntry = true;
      }
    } else {
      if (freshEntry) {
        // 最初の1桁目。「0」を押した場合もそのまま記録する（例: 0→4→5 で2桁の45円を3桁分の入力として扱える）
        currentInput = key;
        freshEntry = false;
      } else if (currentInput.length >= DIGIT_CAP) {
        // 桁上限に達したら、新しい値の入力とみなしてリセットしてから入れ直す
        currentInput = key;
      } else {
        currentInput += key;
      }
    }
    renderCalc();
  });

  function renderCalc() {
    // 入力した文字列をそのまま表示する（先頭の「0」も見えるようにするため。最大3桁なので桁区切りは不要）
    inputEl.textContent = currentInput;
    const price = Number(currentInput) || 0;

    for (let i = 0; i < 3; i++) {
      const rate = settings["rate" + (i + 1)];
      const text = price > 0
        ? formatYen(computeDiscounted(price, rate, settings.roundMode, settings.roundUnit))
        : "-";
      tileRows[i].valueEl.textContent = text;
      circleRows[i].valueEl.textContent = text;
    }
  }

  function renderLabels() {
    for (let i = 0; i < 3; i++) {
      const pct = settings["rate" + (i + 1)] + "%";
      tileRows[i].pctEl.textContent = pct;
      circleRows[i].pctEl.textContent = pct;
    }
    updateLayoutRatios();
    renderCalc();
  }

  function applyDisplayStyle() {
    const style = settings.displayStyle;
    tilesEl.hidden = style !== "tiles";
    circlesEl.hidden = style !== "circles";
    // 表示直後はレイアウトが確定してから実寸を測る必要があるため、次のフレームで計算する
    if (style === "circles") requestAnimationFrame(updateCircleSizes);
  }

  // ---------- Settings screen ----------

  const settingsBody = document.getElementById("settings-body");

  function renderSettings() {
    settingsBody.innerHTML = "";
    settingsBody.appendChild(buildRatesGroup());
    settingsBody.appendChild(buildDisplayGroup());
    settingsBody.appendChild(buildScreenGroup());
    settingsBody.appendChild(buildKeypadOrderGroup());
  }

  function buildScreenGroup() {
    const group = document.createElement("div");
    group.className = "settings-group";

    const heading = document.createElement("h2");
    heading.textContent = "画面";
    group.appendChild(heading);

    const row = document.createElement("div");
    row.className = "settings-row";

    const label = document.createElement("label");
    label.htmlFor = "keep-awake";
    label.textContent = wakeLockSupported
      ? "使用中は画面を暗くしない"
      : "使用中は画面を暗くしない（この端末は非対応）";
    row.appendChild(label);

    const sw = document.createElement("span");
    sw.className = "switch";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = "keep-awake";
    input.checked = settings.keepAwake;
    input.disabled = !wakeLockSupported;
    input.addEventListener("change", () => {
      settings.keepAwake = input.checked;
      saveSettings();
      updateWakeLock();
    });
    sw.appendChild(input);

    const track = document.createElement("span");
    track.className = "switch-track";
    sw.appendChild(track);

    row.appendChild(sw);
    group.appendChild(row);

    return group;
  }

  function buildRatesGroup() {
    const group = document.createElement("div");
    group.className = "settings-group";

    const heading = document.createElement("h2");
    heading.textContent = "値引き率・端数処理";
    group.appendChild(heading);

    for (let i = 1; i <= 3; i++) {
      group.appendChild(buildRateRow("rate" + i, `値引き率${i}`, settings["rate" + i]));
    }
    group.appendChild(buildRoundModeRow());
    group.appendChild(buildRoundUnitRow());

    return group;
  }

  function buildRateRow(field, labelText, value) {
    const row = document.createElement("div");
    row.className = "settings-row";

    const label = document.createElement("label");
    label.textContent = labelText;
    row.appendChild(label);

    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "6px";

    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "99";
    input.value = value;
    input.addEventListener("change", () => {
      let n = Math.round(Number(input.value));
      if (isNaN(n) || n < 0) n = 0;
      if (n > 99) n = 99;
      input.value = n;
      settings[field] = n;
      saveSettings();
      renderLabels();
    });
    wrap.appendChild(input);

    const unit = document.createElement("span");
    unit.className = "unit";
    unit.textContent = "%引き";
    wrap.appendChild(unit);

    row.appendChild(wrap);
    return row;
  }

  function buildRoundModeRow() {
    const row = document.createElement("div");
    row.className = "settings-row";

    const label = document.createElement("label");
    label.textContent = "端数処理";
    row.appendChild(label);

    const select = document.createElement("select");
    for (const mode of ROUNDING_MODES) {
      const opt = document.createElement("option");
      opt.value = mode.id;
      opt.textContent = mode.name;
      if (mode.id === settings.roundMode) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      settings.roundMode = select.value;
      saveSettings();
      renderCalc();
    });
    row.appendChild(select);
    return row;
  }

  function buildRoundUnitRow() {
    const row = document.createElement("div");
    row.className = "settings-row";

    const label = document.createElement("label");
    label.textContent = "丸め単位";
    row.appendChild(label);

    const select = document.createElement("select");
    for (const unit of ROUND_UNITS) {
      const opt = document.createElement("option");
      opt.value = unit;
      opt.textContent = unit + "円単位";
      if (unit === settings.roundUnit) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      settings.roundUnit = Number(select.value);
      saveSettings();
      renderCalc();
    });
    row.appendChild(select);
    return row;
  }

  function buildDisplayGroup() {
    const group = document.createElement("div");
    group.className = "settings-group";

    const heading = document.createElement("h2");
    heading.textContent = "表示スタイル";
    group.appendChild(heading);

    const row = document.createElement("div");
    row.className = "settings-row";

    const label = document.createElement("label");
    label.textContent = "結果の見せ方";
    row.appendChild(label);

    const select = document.createElement("select");
    for (const style of DISPLAY_STYLES) {
      const opt = document.createElement("option");
      opt.value = style.id;
      opt.textContent = style.name;
      if (style.id === settings.displayStyle) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      settings.displayStyle = select.value;
      saveSettings();
      applyDisplayStyle();
    });
    row.appendChild(select);
    group.appendChild(row);

    const yenRow = document.createElement("div");
    yenRow.className = "settings-row";

    const yenLabel = document.createElement("label");
    yenLabel.textContent = "¥マーク";
    yenRow.appendChild(yenLabel);

    const yenSelect = document.createElement("select");
    const yenOptions = [
      { id: "on", name: "¥ あり" },
      { id: "off", name: "¥ なし" },
    ];
    for (const opt of yenOptions) {
      const o = document.createElement("option");
      o.value = opt.id;
      o.textContent = opt.name;
      if ((opt.id === "on") === settings.showYenSign) o.selected = true;
      yenSelect.appendChild(o);
    }
    yenSelect.addEventListener("change", () => {
      settings.showYenSign = yenSelect.value === "on";
      saveSettings();
      renderCalc();
    });
    yenRow.appendChild(yenSelect);
    group.appendChild(yenRow);

    return group;
  }

  function buildKeypadOrderGroup() {
    const group = document.createElement("div");
    group.className = "settings-group";

    const heading = document.createElement("h2");
    heading.textContent = "テンキー";
    group.appendChild(heading);

    const row = document.createElement("div");
    row.className = "settings-row";

    const label = document.createElement("label");
    label.textContent = "数字の並び順";
    row.appendChild(label);

    const select = document.createElement("select");
    const options = [
      { id: "phone", name: "1・2・3を上に" },
      { id: "calc", name: "7・8・9を上に" },
    ];
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt.id;
      o.textContent = opt.name;
      if (opt.id === settings.keypadOrder) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener("change", () => {
      settings.keypadOrder = select.value;
      saveSettings();
      applyKeypadOrder();
    });
    row.appendChild(select);
    group.appendChild(row);

    return group;
  }

  // ---------- Screen navigation ----------

  const screenMain = document.getElementById("screen-main");
  const screenSettings = document.getElementById("screen-settings");
  const settingsBtn = document.getElementById("settings-btn");
  const settingsBack = document.getElementById("settings-back");

  settingsBtn.addEventListener("click", () => {
    screenMain.hidden = true;
    screenSettings.hidden = false;
  });
  settingsBack.addEventListener("click", () => {
    screenSettings.hidden = true;
    screenMain.hidden = false;
  });

  // ---------- Init ----------

  renderLabels();
  applyDisplayStyle();
  renderSettings();
  applyKeypadOrder();
  updateWakeLock();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
