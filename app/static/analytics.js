const $ = (id) => document.getElementById(id);
const CHART_URL = "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js";
const CHART_INTEGRITY = "sha384-jb8JQMbMoBUzgWatfe6COACi2ljcDdZQ2OxczGA3bGNeWe+6DChMTBJemed7ZnvJ";
const COLORS = ["#376e56", "#8eaf6e", "#d7aa71", "#759aa2", "#a28bb5", "#d08a7e",
  "#819b8a", "#ac9c60", "#7997bd", "#bd9272", "#9cae6f"];
const INCOME = "#518267";
const EXPENSE = "#c58f54";
const MONEY = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB",
  maximumFractionDigits: 2, minimumFractionDigits: 0 });
const DAY_LABEL = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const MONTH_LABEL = new Intl.DateTimeFormat("ru-RU", { month: "short", year: "2-digit" });
const SHORT_NUMBER = new Intl.NumberFormat("ru-RU", { notation: "compact" });
const auditButton = $("analyze-budget");
const exportButtons = [...document.querySelectorAll("[data-export]")];
let active;
let online = navigator.onLine;
let chartLoading = false;
let categoryChart;
let trendChart;
let exporting = false;
let auditBusy = false;

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function loadChartLibrary() {
  if (chartLoading || window.Chart || !online) return;
  chartLoading = true;
  const script = document.createElement("script");
  script.src = CHART_URL;
  script.integrity = CHART_INTEGRITY;
  script.crossOrigin = "anonymous";
  script.onload = () => {
    chartLoading = false;
    if (active) drawCharts();
  };
  script.onerror = () => {
    chartLoading = false;
    script.remove();
  };
  document.head.append(script);
}

export function setAnalyticsOnline(available) {
  const reconnected = available && !online;
  online = available;
  if (reconnected) loadChartLibrary();
  updateExportState();
}

function dayKey(date, monthly) {
  const prefix = String(date.getFullYear()).padStart(4, "0") + "-" + String(date.getMonth() + 1).padStart(2, "0");
  return monthly ? prefix : prefix + "-" + String(date.getDate()).padStart(2, "0");
}

function aggregate(rows, selection) {
  const categories = new Map();
  const buckets = new Map();
  const monthly = selection.period === "all";
  let income = 0;
  let expense = 0;
  if (rows.length && !monthly) {
    const day = new Date(selection.from);
    const end = new Date();
    while (day <= end) {
      buckets.set(dayKey(day, false), { income: 0, expense: 0, label: DAY_LABEL.format(day) });
      day.setDate(day.getDate() + 1);
    }
  }
  for (const row of rows) {
    const date = new Date(row.created_at);
    const key = dayKey(date, monthly);
    const bucket = buckets.get(key) || {
      income: 0, expense: 0, label: (monthly ? MONTH_LABEL : DAY_LABEL).format(date),
    };
    bucket[row.type] += row.amount;
    buckets.set(key, bucket);
    if (row.type === "expense") {
      expense += row.amount;
      categories.set(row.category, (categories.get(row.category) || 0) + row.amount);
    } else {
      income += row.amount;
    }
  }
  return {
    income, expense,
    categories: [...categories].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru")),
    trend: [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value),
  };
}

function renderCategories() {
  const { categories, expense } = active.summary;
  $("category-empty").hidden = Boolean(categories.length);
  $("category-plot").hidden = !categories.length;
  $("category-total").textContent = MONEY.format(expense);
  $("category-content").classList.toggle("has-data", Boolean(categories.length));
  let angle = 0;
  const gradient = [];
  const legend = categories.map(([category, value], index) => {
    const color = COLORS[index % COLORS.length];
    const start = angle;
    angle += value / expense * 100;
    gradient.push(color + " " + start + "% " + Math.min(angle, 100) + "%");
    const item = element("li", "category-legend-item");
    const dot = element("i", "category-dot");
    dot.style.backgroundColor = color;
    const label = element("span", "category-name", category);
    label.title = category;
    item.append(dot, label, element("strong", "", MONEY.format(value)));
    return item;
  });
  $("category-legend").replaceChildren(...legend);
  $("category-donut").style.background = gradient.length
    ? "conic-gradient(" + gradient.join(",") + ")"
    : "";
}

function renderTrendFallback() {
  const { trend } = active.summary;
  $("trend-empty").hidden = Boolean(trend.length);
  $("trend-key").hidden = !trend.length;
  const max = trend.reduce((largest, point) => Math.max(largest, point.income, point.expense), 0);
  const rows = trend.map((point) => {
    const item = element("li", "trend-row");
    const bars = element("div", "trend-bars");
    for (const [type, label] of [["income", "Доходы"], ["expense", "Расходы"]]) {
      const bar = element("span", type + "-bar");
      bar.style.width = (max ? point[type] / max * 100 : 0) + "%";
      bar.setAttribute("role", "img");
      bar.setAttribute("aria-label", label + ": " + MONEY.format(point[type]));
      bar.title = label + ": " + MONEY.format(point[type]);
      bars.append(bar);
    }
    item.append(element("span", "", point.label), bars);
    return item;
  });
  const list = element("ul", "trend-list");
  list.append(...rows);
  $("trend-fallback").replaceChildren(...(rows.length ? [list] : []));
}

function drawCharts() {
  categoryChart?.destroy();
  trendChart?.destroy();
  categoryChart = trendChart = undefined;
  const { categories, trend } = active.summary;
  let hasCategoryChart = false;
  let hasTrendChart = false;
  const Chart = window.Chart;
  if (Chart) {
    const options = { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } } };
    try {
      if (categories.length) {
        $("category-canvas-wrap").hidden = false;
        categoryChart = new Chart($("category-chart"), {
          type: "doughnut",
          data: {
            labels: categories.map(([label]) => label),
            datasets: [{
              data: categories.map(([, amount]) => amount),
              backgroundColor: categories.map((_, index) => COLORS[index % COLORS.length]),
              borderWidth: 2, borderColor: "#fff",
            }],
          },
          options: { ...options, cutout: "76%" },
        });
        hasCategoryChart = true;
      }
      if (trend.length) {
        $("trend-canvas-wrap").hidden = false;
        trendChart = new Chart($("trend-chart"), {
          type: "bar",
          data: {
            labels: trend.map(({ label }) => label),
            datasets: [
              { label: "Доходы", data: trend.map(({ income }) => income),
                backgroundColor: INCOME, borderRadius: 4, maxBarThickness: 24 },
              { label: "Расходы", data: trend.map(({ expense }) => expense),
                backgroundColor: EXPENSE, borderRadius: 4, maxBarThickness: 24 },
            ],
          },
          options: { ...options, scales: {
            x: { grid: { display: false }, ticks: { maxTicksLimit: 10, maxRotation: 0 } },
            y: { beginAtZero: true, grid: { color: "#ecf0e9" },
              ticks: { maxTicksLimit: 5, callback: (value) => SHORT_NUMBER.format(value) } },
          } },
        });
        hasTrendChart = true;
      }
    } catch (error) {
      console.warn("SmartBudget chart initialization failed", error);
      Chart.getChart($("category-chart"))?.destroy();
      Chart.getChart($("trend-chart"))?.destroy();
      categoryChart = trendChart = undefined;
      hasCategoryChart = hasTrendChart = false;
    }
  }
  $("category-canvas-wrap").hidden = !hasCategoryChart;
  $("category-donut").hidden = hasCategoryChart;
  $("trend-canvas-wrap").hidden = !hasTrendChart;
  $("trend-fallback").classList.toggle("visually-hidden", hasTrendChart);
}

function updateExportState() {
  for (const button of exportButtons) button.disabled = exporting || !online;
  const status = $("export-status");
  if (!online) {
    status.textContent = "Для выгрузки нужен доступ к серверу.";
    status.hidden = false;
  } else if (!exporting && status.dataset.offline === "true") {
    status.hidden = true;
  }
  status.dataset.offline = String(!online);
}

function showAudit(observations, source) {
  const card = $("audit-result");
  const label = element("p", "audit-source", source === "ai" ? "OpenAI" : "Статистический анализ");
  const list = element("ol");
  list.append(...observations.map((value) => element("li", "", value)));
  card.replaceChildren(label, list);
  card.hidden = false;
}

function offlineAudit({ income, expense, categories }) {
  const largest = categories[0];
  const observations = [
    "Доходы — " + MONEY.format(income) + ", расходы — " + MONEY.format(expense)
      + ", сальдо — " + MONEY.format(income - expense) + ".",
    largest
      ? "Больше всего расходов в категории «" + largest[0] + "» — " + MONEY.format(largest[1]) + "."
      : "В выборке нет расходов.",
    largest
      ? "Проверьте регулярные траты этой категории. Сокращение на 10% дало бы экономию около "
        + MONEY.format(largest[1] / 10) + " за такой же период."
      : "Добавьте расходы, чтобы оценить возможности экономии.",
  ];
  return { observations, parsed_by: "fallback" };
}

auditButton.addEventListener("click", async () => {
  if (!active?.rows.length || auditBusy) return;
  const current = active;
  let result;
  auditBusy = true;
  auditButton.disabled = true;
  auditButton.lastElementChild.textContent = "Анализируем…";
  try {
    if (online) {
      const response = await fetch("/api/analytics/insights", {
        method: "POST", signal: AbortSignal.timeout(15000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactions: current.rows }),
      });
      if (response.ok) result = await response.json();
    }
  } catch (error) {
    console.info("Using local audit", error.name);
  } finally {
    auditBusy = false;
    auditButton.disabled = !active.rows.length;
    auditButton.lastElementChild.textContent = "Проанализировать траты";
  }
  if (active !== current) return;
  result ||= offlineAudit(current.summary);
  showAudit(result.observations, result.parsed_by);
});

for (const button of exportButtons) {
  button.addEventListener("click", async () => {
    if (!online || exporting || !active) return;
    const format = button.dataset.export;
    const query = new URLSearchParams();
    const { from, type, category } = active.selection;
    if (Number.isFinite(from)) query.set("start_at", new Date(from).toISOString());
    if (type) query.set("type", type);
    if (category) query.set("category", category);
    const status = $("export-status");
    exporting = true;
    status.textContent = "Готовим отчёт…";
    status.hidden = false;
    updateExportState();
    try {
      const response = await fetch("/api/export/" + format + "?" + query, {
        cache: "no-store", signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "smartbudget_report." + (format === "excel" ? "xlsx" : "csv");
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      status.hidden = true;
    } catch (error) {
      status.textContent = "Не удалось скачать отчёт. Проверьте соединение и повторите попытку.";
    } finally {
      exporting = false;
      updateExportState();
    }
  });
}

export function renderAnalytics(rows, selection) {
  const snapshot = rows.map(({ amount, type, category, created_at }) => ({
    amount, type, category, created_at,
  }));
  const key = JSON.stringify([selection, snapshot]);
  if (active?.key === key) return;
  active = { key, rows: snapshot, selection, summary: aggregate(snapshot, selection) };
  $("analytics-period").textContent = selection.periodLabel;
  $("audit-result").hidden = true;
  auditButton.disabled = auditBusy || !rows.length;
  renderCategories();
  renderTrendFallback();
  drawCharts();
}

loadChartLibrary();
