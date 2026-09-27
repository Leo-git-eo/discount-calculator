(() => {
  "use strict";

  const STORAGE_KEY = "discount-calc-settings-v1";
  const KEYPAD_ORDER_KEY = "discount-calc-keypad-order";
  const DIGIT_CAP = 3;

  const CATEGORY_META = [
    { id: "grocery", name: "グロッサリー" },
    { id: "daily", name: "日配" },
    { id: "bread", name: "パン" },
  ];

  // カテゴリごとの値引き段階数（パンのみ3段階、他は2段階）
  const STAGE_COUNTS = { grocery: 2, daily: 2, bread: 3 };

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

  function defaultSettings() {
    return {
      grocery: { rate1: 20, rate2: 50, roundMode: "floor", roundUnit: 1 },
      daily: { rate1: 10, rate2: 30, roundMode: "floor", roundUnit: 1 },
      // パン参考値: 翌日付2割引/菓子・惣菜・和洋菓子は当日3割引/食パンは当日半額
      bread: { rate1: 20, rate2: 30, rate3: 50, roundMode: "floor", roundUnit: 1 },
    };
  }

  function loadSettings() {
    const fallback = defaultSettings();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      const merged = {};
      for (const cat of CATEGORY_META) {
        merged[cat.id] = Object.assign({}, fallback[cat.id], parsed[cat.id] || {});
      }
      return merged;
    } catch (e) {
      return fallback;
    }
  }

  let settings = loadSettings();
  let keypadOrder = localStorage.getItem(KEYPAD_ORDER_KEY) || "phone";

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
    return "¥" + n.toLocaleString("ja-JP");
  }

  // ---------- Keypad order ----------

  function applyKeypadOrder(mode) {
    const order = KEYPAD_ORDERS[mode] || KEYPAD_ORDERS.phone;
    document.querySelectorAll(".keypad").forEach((keypad) => {
      order.forEach((key, idx) => {
        const btn = keypad.querySelector(`[data-key="${key}"]`);
        if (btn) btn.style.order = idx;
      });
    });
  }

  // ---------- Calculator screens ----------

  const screensContainer = document.getElementById("screens");
  const calcTemplate = document.getElementById("calc-template");
  const calcStates = {}; // categoryId -> { inputEl, pctNEl, valueNEl, currentInput }

  function buildCalcScreen(cat) {
    const stageCount = STAGE_COUNTS[cat.id] || 2;
    const frag = calcTemplate.content.cloneNode(true);
    const section = frag.querySelector(".calc-screen");
    section.id = "screen-" + cat.id;
    section.classList.add("screen");
    section.hidden = true;

    const inputEl = frag.querySelector('[data-role="input"]');
    const keypad = frag.querySelector('[data-role="keypad"]');
    const resultsEl = frag.querySelector('[data-role="results"]');
    resultsEl.dataset.stageCount = String(stageCount);

    const state = { inputEl, currentInput: "0", stageCount, rows: [] };

    for (let i = 1; i <= 3; i++) {
      const pctEl = frag.querySelector(`[data-role="pct${i}"]`);
      const valueEl = frag.querySelector(`[data-role="value${i}"]`);
      if (i > stageCount) {
        pctEl.closest(".result-tile").remove();
        continue;
      }
      state.rows.push({ pctEl, valueEl });
    }

    keypad.addEventListener("click", (e) => {
      const btn = e.target.closest(".key");
      if (!btn) return;
      const key = btn.dataset.key;
      if (key === "clear") {
        state.currentInput = "0";
      } else if (key === "back") {
        state.currentInput = state.currentInput.length > 1
          ? state.currentInput.slice(0, -1)
          : "0";
      } else {
        if (state.currentInput === "0") {
          state.currentInput = key;
        } else if (state.currentInput.length >= DIGIT_CAP) {
          // 桁上限に達したら、新しい値の入力とみなしてリセットしてから入れ直す
          state.currentInput = key;
        } else {
          state.currentInput += key;
        }
      }
      renderCalc(cat.id);
    });

    screensContainer.appendChild(frag);
    calcStates[cat.id] = state;
  }

  function renderCalc(catId) {
    const state = calcStates[catId];
    const conf = settings[catId];
    state.inputEl.textContent = Number(state.currentInput).toLocaleString("ja-JP");

    const price = Number(state.currentInput) || 0;
    state.rows.forEach((row, i) => {
      if (price <= 0) {
        row.valueEl.textContent = "-";
        return;
      }
      const rate = conf["rate" + (i + 1)];
      const v = computeDiscounted(price, rate, conf.roundMode, conf.roundUnit);
      row.valueEl.textContent = formatYen(v);
    });
  }

  function renderAllCalcLabels() {
    for (const cat of CATEGORY_META) {
      const conf = settings[cat.id];
      const state = calcStates[cat.id];
      if (!state) continue;
      state.rows.forEach((row, i) => {
        row.pctEl.textContent = `${conf["rate" + (i + 1)]}%`;
      });
      renderCalc(cat.id);
    }
  }

  // ---------- Settings screen ----------

  const settingsBody = document.getElementById("settings-body");

  function renderSettings() {
    settingsBody.innerHTML = "";
    settingsBody.appendChild(buildKeypadOrderGroup());

    for (const cat of CATEGORY_META) {
      const conf = settings[cat.id];
      const stageCount = STAGE_COUNTS[cat.id] || 2;
      const group = document.createElement("div");
      group.className = "settings-group";

      const heading = document.createElement("h2");
      heading.textContent = cat.name;
      group.appendChild(heading);

      for (let i = 1; i <= stageCount; i++) {
        group.appendChild(buildRateRow(cat.id, "rate" + i, `値引き率${i}`, conf["rate" + i]));
      }
      group.appendChild(buildRoundModeRow(cat.id, conf.roundMode));
      group.appendChild(buildRoundUnitRow(cat.id, conf.roundUnit));

      settingsBody.appendChild(group);
    }
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
      if (opt.id === keypadOrder) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener("change", () => {
      keypadOrder = select.value;
      localStorage.setItem(KEYPAD_ORDER_KEY, keypadOrder);
      applyKeypadOrder(keypadOrder);
    });
    row.appendChild(select);
    group.appendChild(row);

    return group;
  }

  function buildRateRow(catId, field, labelText, value) {
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
      settings[catId][field] = n;
      saveSettings();
      renderAllCalcLabels();
    });
    wrap.appendChild(input);

    const unit = document.createElement("span");
    unit.className = "unit";
    unit.textContent = "%引き";
    wrap.appendChild(unit);

    row.appendChild(wrap);
    return row;
  }

  function buildRoundModeRow(catId, value) {
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
      if (mode.id === value) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      settings[catId].roundMode = select.value;
      saveSettings();
      renderAllCalcLabels();
    });
    row.appendChild(select);
    return row;
  }

  function buildRoundUnitRow(catId, value) {
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
      if (unit === value) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      settings[catId].roundUnit = Number(select.value);
      saveSettings();
      renderAllCalcLabels();
    });
    row.appendChild(select);
    return row;
  }

  // ---------- Tab navigation ----------

  const tabs = document.querySelectorAll(".tab");
  const settingsScreen = document.getElementById("screen-settings");

  function showTab(tabId) {
    for (const cat of CATEGORY_META) {
      const screen = document.getElementById("screen-" + cat.id);
      if (screen) screen.hidden = cat.id !== tabId;
    }
    settingsScreen.hidden = tabId !== "settings";

    for (const tab of tabs) {
      tab.classList.toggle("active", tab.dataset.tab === tabId);
    }

    localStorage.setItem("discount-calc-last-tab", tabId);
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
  }

  // ---------- Init ----------

  for (const cat of CATEGORY_META) {
    buildCalcScreen(cat);
  }
  renderAllCalcLabels();
  renderSettings();
  applyKeypadOrder(keypadOrder);

  const lastTab = localStorage.getItem("discount-calc-last-tab");
  const initialTab = CATEGORY_META.some((c) => c.id === lastTab) || lastTab === "settings"
    ? lastTab
    : "grocery";
  showTab(initialTab);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
