import {
  readState, replaceTransactions, acceptTransactions, enqueue, removePending,
  enqueueDeletion, acceptDeletion,
} from "./storage.js";
import { renderAnalytics, setAnalyticsOnline } from "./analytics.js";

const API = "/api/transactions";
const CATEGORIES = [
  "Продукты", "Кафе и рестораны", "Транспорт и авто", "Жильё и ЖКХ", "Здоровье",
  "Одежда", "Развлечения", "Подписки", "Зарплата", "Переводы/Возвраты", "Другое",
];
const PERIODS = { all: "За всё время", today: "Сегодня", week: "За неделю", month: "За месяц" };
const money = new Intl.NumberFormat("ru-RU", {
  style: "currency", currency: "RUB", minimumFractionDigits: 0, maximumFractionDigits: 2,
});
const transactionDate = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const $ = (id) => document.getElementById(id);
const smartInput = $("smart-text");
const syncButton = $("sync");
const demoButton = $("seed-demo");
const channel = "BroadcastChannel" in window ? new BroadcastChannel("smartbudget-data") : null;
let state = { transactions: [], outbox: [], deletions: [] };
let online = navigator.onLine;
let busy = false;
let syncRequested = false;
let preview;
let installPrompt;
let noticeTimer;
let reconnectTimer;
let reconnectDelay = 1000;

class NetworkError extends Error {}
class ApiError extends Error {
  constructor(status) {
    super("HTTP " + status);
    this.status = status;
  }
}

function setNetwork(available) {
  online = available;
  $("network-status").dataset.online = String(available);
  $("network-label").textContent = available ? "Online" : "Offline";
  setAnalyticsOnline(available);
  demoButton.disabled = busy || !available;
  if (available || !navigator.onLine) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    reconnectDelay = 1000;
  } else if (!reconnectTimer) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      synchronize();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }
}

async function request(path = "", { method = "GET", body, allowMissing = false } = {}) {
  if (!navigator.onLine) throw new NetworkError();
  let response;
  try {
    response = await fetch(API + path, {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new NetworkError("API unavailable", { cause: error });
  }
  if (response.headers.get("X-SmartBudget-Offline") || response.status >= 500) {
    throw new NetworkError("API unavailable");
  }
  setNetwork(true);
  if (response.status === 204 || (allowMissing && response.status === 404)) return;
  if (!response.ok) throw new ApiError(response.status);
  try {
    return await response.json();
  } catch (error) {
    throw new NetworkError("Invalid API response", { cause: error });
  }
}

function notice(message, error = false) {
  clearTimeout(noticeTimer);
  const element = $("notice");
  element.textContent = message;
  element.dataset.error = String(error);
  element.hidden = false;
  noticeTimer = setTimeout(() => { element.hidden = true; }, 4500);
}

function make(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function icon(name) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  const use = document.createElementNS(namespace, "use");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

function option(value) {
  return new Option(value, value);
}

function periodStart(period) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  if (period === "week") date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  if (period === "month") date.setDate(1);
  return period === "all" ? -Infinity : date.getTime();
}

function totals(rows) {
  const sums = { income: 0, expense: 0 };
  for (const row of rows) sums[row.type] += row.amount;
  return sums;
}

function formatAmount(amount) {
  return money.format(Math.abs(amount) < 0.005 ? 0 : amount);
}

function transactionItem(row) {
  const item = make("li", "transaction");
  item.dataset.type = row.type;
  const direction = make("span", "transaction-icon");
  direction.append(icon(row.type === "income" ? "in" : "out"));
  const information = make("div");
  const date = transactionDate.format(new Date(row.created_at));
  const details = make("p", "transaction-details", row.category + " · " + date);
  if (row.pending) {
    details.append(document.createElement("br"), make("span", "pending", "◷ Ожидает сети"));
  }
  information.append(make("p", "transaction-name", row.description || row.category), details);

  const amount = make("span", "transaction-amount", (row.type === "income" ? "+" : "−") + formatAmount(row.amount));
  const remove = make("button", "delete");
  remove.type = "button";
  remove.dataset.remove = row.pending ? row.client_tx_id : String(row.id);
  remove.dataset.pending = String(Boolean(row.pending));
  remove.setAttribute("aria-label", "Удалить: " + (row.description || row.category));
  remove.title = "Удалить";
  remove.disabled = busy;
  remove.append(icon("trash"));
  item.append(direction, information, amount, remove);
  return item;
}

function render() {
  const deleted = new Set(state.deletions.map((row) => row.id));
  const confirmedIds = new Set(state.transactions.map((row) => row.client_tx_id));
  const rows = [
    ...state.transactions.filter((row) => !deleted.has(row.id)),
    ...state.outbox.filter((row) => !confirmedIds.has(row.client_tx_id)).map((row) => ({
      ...row, pending: true,
    })),
  ].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || (b.id ?? 0) - (a.id ?? 0));

  const queueSize = state.outbox.length + state.deletions.length;
  $("queue-count").textContent = queueSize;
  $("queue-count").setAttribute("aria-label", "Записей в очереди: " + queueSize);

  const categoryFilter = $("filter-category");
  const selectedCategory = categoryFilter.value;
  const categories = [...new Set([...CATEGORIES, ...rows.map((row) => row.category)])];
  categoryFilter.replaceChildren(new Option("Все категории", ""), ...categories.map(option));
  if (categories.includes(selectedCategory)) categoryFilter.value = selectedCategory;

  const period = $("filter-period").value;
  const from = periodStart(period);
  const dateRows = rows.filter((row) => Date.parse(row.created_at) >= from);
  const all = totals(rows);
  const selected = totals(dateRows);
  $("balance").textContent = formatAmount(all.income - all.expense);
  $("income").textContent = formatAmount(selected.income);
  $("expense").textContent = formatAmount(selected.expense);
  $("income-period").textContent = PERIODS[period];
  $("expense-period").textContent = PERIODS[period];

  const type = $("filter-type").value;
  const visible = dateRows.filter((row) => (
    (!type || row.type === type) && (!categoryFilter.value || row.category === categoryFilter.value)
  ));
  const list = $("transactions");
  list.replaceChildren(...visible.map(transactionItem));
  list.hidden = !visible.length;
  $("empty-state").hidden = Boolean(visible.length);
  const filtersActive = type || categoryFilter.value || period !== "all";
  $("activity-summary").textContent = rows.length ? "Записей: " + visible.length : "История операций";
  $("empty-title").textContent = filtersActive ? "По фильтрам ничего не найдено" : "Здесь будут ваши операции";
  $("empty-description").textContent = filtersActive
    ? "Измените тип, категорию или период."
    : "Добавьте первую запись, чтобы начать вести бюджет.";
  $("empty-action").hidden = Boolean(filtersActive);
  renderAnalytics(visible, {
    period, periodLabel: PERIODS[period], from, type, category: categoryFilter.value,
  });
}

async function reloadState() {
  state = await readState();
  render();
}

function parseLocally(text) {
  const rows = [];
  const separator = /(?<![0-9]),|,(?![0-9])|[;\n!?]|\s+и\s+/iu;
  const amountPattern = /[0-9]{1,3}(?:[ \u00a0\u202f][0-9]{3})+(?:[.,][0-9]+)?|[0-9]+(?:[.,][0-9]+)?/g;
  const clean = (value) => value.trim().replace(/^[.:—–-]+|[.:—–-]+$/gu, "").trim();
  for (const clause of text.split(separator)) {
    const matches = [...clause.matchAll(amountPattern)];
    if (!matches.length) continue;
    const amountFirst = !clean(clause.slice(0, matches[0].index));
    for (const [index, match] of matches.entries()) {
      const amount = Number(match[0].replace(/[ \u00a0\u202f]/gu, "").replace(",", "."));
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const previous = matches[index - 1];
      const next = matches[index + 1];
      const description = amountFirst
        ? clause.slice(match.index + match[0].length, next?.index)
        : clause.slice(previous ? previous.index + previous[0].length : 0, match.index);
      rows.push({ amount, type: "expense", category: "Другое", description: [...clean(description)].slice(0, 1000).join("") });
    }
  }
  return { transactions: rows, parsed_by: "fallback" };
}

function renderPreview() {
  const element = $("preview");
  element.replaceChildren();
  element.hidden = !preview;
  $("smart-submit").lastElementChild.textContent = preview?.transactions.length
    ? "Добавить операции"
    : "Распознать и добавить";
  if (!preview) return;
  const source = preview.parsed_by === "ai" ? "OpenAI" : "Локальный разбор";
  element.append(make("strong", "", preview.transactions.length ? source : "Суммы не найдены"));
  if (!preview.transactions.length) return;
  const list = make("ul");
  for (const row of preview.transactions) {
    const sign = row.type === "income" ? "+" : "−";
    list.append(make("li", "", (row.description || row.category) + " · " + sign + formatAmount(row.amount)));
  }
  element.append(list);
}

async function refreshTransactions() {
  const rows = await request();
  const ids = new Set(rows.map((row) => row.client_tx_id));
  const { outbox } = await readState();
  // A failed quick-add response can still have committed on the server.
  const acknowledged = outbox.filter((row) => (
    ids.has(row.client_tx_id) || (row.quickPrefix && ids.has(row.quickPrefix + ":1"))
  ));
  await replaceTransactions(rows, acknowledged.map((row) => row.client_tx_id));
}

async function flushOutbox() {
  const { outbox, deletions } = await readState();
  for (let offset = 0; offset < outbox.length; offset += 500) {
    const transactions = outbox.slice(offset, offset + 500).map(({ quickPrefix, ...row }) => row);
    const { created, skipped_client_tx_ids: skipped } = await request("/sync", {
      method: "POST", body: { transactions },
    });
    await acceptTransactions(created, [...created.map((row) => row.client_tx_id), ...skipped]);
  }
  for (const { id } of deletions) {
    await request("/" + id, { method: "DELETE", allowMissing: true });
    await acceptDeletion(id);
  }
}

function setBusy(value) {
  busy = value;
  for (const button of document.querySelectorAll(
    "#smart-form button, #manual-form button, #transactions button, #sync"
  )) {
    button.disabled = value;
  }
  syncButton.setAttribute("aria-busy", String(value));
  demoButton.disabled = value || !online;
}

async function runAction(action) {
  if (busy) return;
  setBusy(true);
  try {
    if (navigator.locks) await navigator.locks.request("smartbudget-writes", action);
    else await action();
  } catch (error) {
    if (error instanceof NetworkError) {
      setNetwork(false);
      notice("Нет соединения с сервером. Повторите синхронизацию позже.", true);
    } else if (error instanceof ApiError) {
      notice("Сервер отклонил запрос (" + error.status + ").", true);
    } else {
      console.error(error);
      notice("Не удалось обработать запись. Проверьте доступ к хранилищу браузера.", true);
    }
  } finally {
    try {
      await reloadState();
      channel?.postMessage("updated");
    } catch (error) {
      console.error(error);
      notice("Хранилище браузера недоступно.", true);
    }
    setBusy(false);
    if (syncRequested) {
      syncRequested = false;
      synchronize();
    }
  }
}

function synchronize(showNotice = false) {
  if (busy) {
    syncRequested = true;
    return;
  }
  return runAction(async () => {
    if (!navigator.onLine) {
      setNetwork(false);
      if (showNotice) notice("Синхронизация начнётся после восстановления сети.");
      return;
    }
    try {
      await refreshTransactions();
      const pending = await readState();
      if (pending.outbox.length || pending.deletions.length) {
        await flushOutbox();
        await refreshTransactions();
      }
      if (showNotice) notice("Синхронизация завершена.");
    } catch (error) {
      if (!(error instanceof NetworkError) || showNotice) throw error;
      setNetwork(false);
    }
  });
}

function prepareRows(rows, quickPrefix) {
  const createdAt = new Date().toISOString();
  return rows.map((row, index) => ({
    ...row,
    created_at: createdAt,
    client_tx_id: quickPrefix ? quickPrefix + ":" + (index + 1) : crypto.randomUUID(),
    ...(quickPrefix ? { quickPrefix } : {}),
  }));
}

function resetSmartForm() {
  smartInput.value = "";
  preview = undefined;
  renderPreview();
}

$("preview-button").addEventListener("click", () => {
  if (!smartInput.reportValidity()) return;
  const text = smartInput.value.trim();
  if (!text) return notice("Введите описание операции.", true);
  runAction(async () => {
    let result;
    try {
      result = online && navigator.onLine
        ? await request("/parse", { method: "POST", body: { text } })
        : parseLocally(text);
    } catch (error) {
      if (!(error instanceof NetworkError)) throw error;
      setNetwork(false);
      result = parseLocally(text);
    }
    if (smartInput.value.trim() === text) {
      preview = { ...result, text };
      renderPreview();
    }
  });
});

$("smart-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = smartInput.value.trim();
  if (!text) return notice("Введите описание операции.", true);
  runAction(async () => {
    const reviewed = preview?.text === text ? preview : undefined;
    if (!reviewed && online && navigator.onLine) {
      const prefix = crypto.randomUUID();
      try {
        const { created } = await request("/quick-add", {
          method: "POST", body: { text, client_tx_id_prefix: prefix },
        });
        if (!created.length) return notice("Суммы не найдены.");
        await acceptTransactions(created);
        if (smartInput.value.trim() === text) resetSmartForm();
        notice("Добавлено операций: " + created.length);
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error;
        setNetwork(false);
        const { transactions } = parseLocally(text);
        if (!transactions.length) return notice("Локальный разбор не нашёл суммы.");
        await enqueue(prepareRows(transactions, prefix));
        if (smartInput.value.trim() === text) resetSmartForm();
        notice("Операции добавлены в очередь.");
      }
      return;
    }

    const { transactions } = reviewed || parseLocally(text);
    if (!transactions.length) return notice("Суммы не найдены.");
    await enqueue(prepareRows(transactions));
    if (smartInput.value.trim() === text) resetSmartForm();
    if (online && navigator.onLine) {
      await flushOutbox();
      await refreshTransactions();
      notice("Добавлено операций: " + transactions.length);
    } else {
      notice("Операции добавлены в очередь.");
    }
  });
});

$("manual-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  const rawAmount = fields.get("amount").trim();
  const amount = Number(rawAmount.replace(/[ \u00a0\u202f]/gu, "").replace(",", "."));
  if (!/^[0-9]+(?:[ \u00a0\u202f][0-9]{3})*(?:[.,][0-9]+)?$/u.test(rawAmount)
      || !Number.isFinite(amount) || amount <= 0) {
    notice("Введите положительную сумму, например 350,50.", true);
    return;
  }
  runAction(async () => {
    const [row] = prepareRows([{
      amount,
      type: fields.get("type"),
      category: fields.get("category"),
      description: fields.get("description").trim(),
    }]);
    await enqueue([row]);
    form.reset();
    if (!online || !navigator.onLine) return notice("Операция добавлена в очередь.");
    try {
      const saved = await request("", { method: "POST", body: row });
      await acceptTransactions([saved], [row.client_tx_id]);
      notice("Операция добавлена.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await refreshTransactions();
        return;
      }
      if (error instanceof ApiError) await removePending(row.client_tx_id);
      throw error;
    }
  });
});

$("transactions").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-remove]");
  if (!button || busy || !window.confirm("Удалить эту операцию?")) return;
  runAction(async () => {
    if (button.dataset.pending === "true") {
      await removePending(button.dataset.remove);
    } else {
      const id = Number(button.dataset.remove);
      await enqueueDeletion(id);
      if (online && navigator.onLine) {
        await request("/" + id, { method: "DELETE", allowMissing: true });
        await acceptDeletion(id);
      } else {
        return notice("Удаление добавлено в очередь.");
      }
    }
    notice("Операция удалена.");
  });
});

function selectTab(id, focus = false) {
  const manual = id === "manual-tab";
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const selected = tab.id === id;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  $("smart-form").hidden = manual;
  $("manual-form").hidden = !manual;
  $("examples").hidden = manual;
}

for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener("click", () => selectTab(tab.id));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = { Home: "smart-tab", End: "manual-tab" }[event.key]
      || (tab.id === "smart-tab" ? "manual-tab" : "smart-tab");
    selectTab(next, true);
  });
}
smartInput.addEventListener("input", () => {
  preview = undefined;
  renderPreview();
});
for (const button of document.querySelectorAll("[data-example]")) {
  button.addEventListener("click", () => {
    smartInput.value = button.dataset.example;
    smartInput.dispatchEvent(new Event("input"));
    smartInput.focus();
  });
}
$("empty-action").addEventListener("click", () => {
  if ($("manual-form").hidden) smartInput.focus({ preventScroll: true });
  else $("amount").focus({ preventScroll: true });
});
for (const id of ["filter-type", "filter-category", "filter-period"]) {
  $(id).addEventListener("change", render);
}
function updateNavigation() {
  const section = location.hash || "#overview";
  for (const link of document.querySelectorAll(".navigation a")) {
    if (link.hash === section) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}
window.addEventListener("hashchange", updateNavigation);

syncButton.addEventListener("click", () => synchronize(true));
demoButton.addEventListener("click", () => runAction(async () => {
  const { created } = await request("/seed-demo", { method: "POST" });
  await acceptTransactions(created);
  await refreshTransactions();
  notice(created.length ? "Добавлено демо-операций: " + created.length : "Демо-данные уже загружены.");
}));
window.addEventListener("online", () => synchronize());
window.addEventListener("offline", () => setNetwork(false));
channel?.addEventListener("message", () => {
  if (!busy) reloadState().catch(console.error);
});
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  $("install").hidden = false;
});
$("install").addEventListener("click", async () => {
  if (!installPrompt) return;
  const prompt = installPrompt;
  installPrompt = undefined;
  $("install").hidden = true;
  try {
    await prompt.prompt();
  } catch (error) {
    console.warn("Install prompt unavailable", error);
  }
});
window.addEventListener("appinstalled", () => {
  installPrompt = undefined;
  $("install").hidden = true;
});

$("manual-category").append(...CATEGORIES.map(option));
$("today").textContent = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric", month: "long", year: "numeric",
}).format(new Date());
updateNavigation();
setNetwork(navigator.onLine);
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((error) => {
    console.warn("Service worker registration failed", error);
  });
}
try {
  await reloadState();
  if (navigator.onLine) synchronize();
} catch (error) {
  console.error(error);
  notice("Хранилище браузера недоступно.", true);
}
