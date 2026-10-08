// The DOM is a view of the local server's readback. It never edits game state
// optimistically, runs scripts, or infers authority from installed tool files.
const bridge = window.currentSkills;
const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 5;
const categories = new Set([
  "default",
  "complex",
  "innate",
  "hidden",
  "talent",
  "item",
  "generic",
  "all",
]);
const model = {
  ownedRunning: false,
  editorConnected: false,
  editorReady: false,
  editable: false,
  installed: false,
  gameRunning: false,
  hero: null,
  skills: [],
  pending: null,
  panel: {
    supported: false,
    kind: "desktop",
    requested: false,
    ready: false,
    reason: "",
  },
  panelAction: "",
  runtimeEpoch: "",
  revision: -1,
  catalog: null,
  query: "",
  category: "default",
  page: 1,
  selection: null,
  busy: false,
  catalogBusy: false,
  message: "",
  messageScope: "",
  tone: "neutral",
};
const names = new Map();
const retiredEpochs = new Set();
let composing = false,
  searchTimer,
  catalogSerial = 0,
  runtimeSerial = 0,
  requestTimer;
let unstate, uneditor;
const bool = (value) =>
  value === true || value === 1 || value === "1" || value === "true";
const text = (value, limit = 400) =>
  typeof value === "string" ? value.slice(0, limit) : "";
const integer = (value, fallback = 0) =>
  Number.isInteger(Number(value)) ? Number(value) : fallback;
const array = (value) =>
  Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.keys(value)
          .filter((key) => /^\d+$/.test(key))
          .sort((a, b) => Number(a) - Number(b))
          .map((key) => value[key])
      : [];
const abilityID = (value) =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(value);
const canRead = () => model.ownedRunning && model.editorConnected;
const canEdit = () =>
  canRead() &&
  model.editorReady &&
  model.editable &&
  !!model.hero &&
  !model.busy &&
  !model.pending;
const nativeHeroName = (name) =>
  text(name)
    .replace(/^npc_dota_hero_/, "")
    .replace(/_/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
const displayName = (item) =>
  text(item.localizedName || names.get(item.name) || item.name, 160);

function validPanelState(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.supported === "boolean" &&
    ["demo", "addon", "desktop"].includes(value.kind) &&
    typeof value.requested === "boolean" &&
    typeof value.ready === "boolean" &&
    typeof value.reason === "string"
  );
}

function panelState(value) {
  if (!validPanelState(value))
    return {
      supported: false,
      kind: "desktop",
      requested: false,
      ready: false,
      reason: "服务器尚未提供游戏内面板状态；请使用桌面编辑。",
    };
  const supported = value.supported && value.kind !== "desktop";
  return {
    supported,
    kind: value.kind,
    requested: supported && value.requested,
    ready: supported && value.ready,
    reason: text(value.reason, 600),
  };
}

function renderPanel() {
  const panel = model.panel;
  const active = panel.requested || panel.ready;
  const connected = canRead();
  const editing = canEdit();
  $("editor-panel-open").disabled = !editing || !panel.supported || active;
  $("editor-panel-close").disabled = !editing || !panel.supported || !active;
  $("editor-panel-open").setAttribute(
    "aria-busy",
    String(model.panelAction === "open"),
  );
  $("editor-panel-close").setAttribute(
    "aria-busy",
    String(model.panelAction === "close"),
  );
  const status = !connected
    ? "等待本机连接"
    : model.panelAction
      ? model.panelAction === "open"
        ? "正在请求打开…"
        : "正在请求关闭…"
      : !panel.supported
        ? "仅桌面编辑"
        : panel.ready
          ? "游戏内面板已就绪"
          : panel.requested
            ? "已请求 · 等待游戏内界面确认"
            : "可以打开游戏内面板";
  $("editor-panel-status").textContent = status;
  $("editor-panel-status").dataset.status = !connected
    ? "waiting"
    : model.panelAction || (panel.requested && !panel.ready)
      ? "loading"
      : panel.supported && panel.ready
        ? "ready"
        : "desktop";
  $("editor-panel-reason").textContent = !connected
    ? "连接本机英雄后读取支持范围。官方试玩或支持的本地游廊可切换游戏内面板；普通比赛仅使用桌面。"
    : panel.reason ||
      (panel.supported
        ? "游戏内面板可用于当前本地地图，桌面编辑始终可用。"
        : "当前地图只使用桌面编辑。普通比赛不加载游戏内面板。");
}

function message(value, tone = "neutral", scope = "") {
  model.message = text(value, 800);
  model.messageScope = scope;
  model.tone = tone;
  renderControls();
}
function panelMessage(value, tone = "neutral") {
  message(value, tone, "panel");
}
function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
}
function skillCopy(skill) {
  const copy = node("div", "editor-skill-copy");
  copy.append(
    node("strong", "", displayName(skill)),
    node("code", "", skill.name),
  );
  const details = [
    bool(skill.hidden) ? "隐藏" : "",
    bool(skill.active) ? "" : "未激活",
  ].filter(Boolean);
  if (details.length) copy.append(node("small", "", details.join(" · ")));
  return copy;
}
function owned(skill) {
  return bool(skill.owned) && !bool(skill.readonly);
}
function levelButton(label, title, action, skill, level) {
  const button = node("button", "editor-button editor-level-button", label);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", `${displayName(skill)}：${title}`);
  button.dataset.editorMutation = action;
  button.dataset.ability = skill.name;
  button.disabled =
    !canEdit() || level < 0 || level > Math.min(100, integer(skill.maxLevel));
  button.addEventListener("click", () => mutate(action, skill.name, level));
  return button;
}
function renderSkills() {
  const added = model.skills.filter(owned),
    native = model.skills.filter((skill) => !owned(skill));
  $("editor-owned-count").textContent = `${added.length} 项`;
  $("editor-native-count").textContent = String(native.length);
  const addedRows = added.map((skill) => {
    const row = node("div", "editor-skill-row");
    row.dataset.ownedSkill = skill.name;
    const controls = node("div", "editor-level-controls");
    controls.append(
      levelButton("−", "降低一级", "level", skill, integer(skill.level) - 1),
      node("span", "editor-level-value", String(skill.level)),
      levelButton("+", "提升一级", "level", skill, integer(skill.level) + 1),
    );
    const remove = node("button", "editor-button editor-remove", "删除");
    remove.type = "button";
    remove.dataset.editorMutation = "remove";
    remove.dataset.ability = skill.name;
    remove.disabled = !canEdit();
    remove.setAttribute("aria-label", `删除工具新增技能 ${displayName(skill)}`);
    remove.addEventListener("click", () => mutate("remove", skill.name));
    controls.append(remove);
    row.append(skillCopy(skill), controls);
    return row;
  });
  $("editor-owned-list").replaceChildren(
    ...(addedRows.length
      ? addedRows
      : [node("p", "editor-empty", "尚未添加技能。从右侧目录选择一个开始。")]),
  );
  $("editor-native-list").replaceChildren(
    ...native.map((skill) => {
      const row = node("div", "editor-skill-row");
      row.dataset.nativeSkill = skill.name;
      row.append(
        skillCopy(skill),
        node(
          "span",
          "editor-native-level",
          `等级 ${skill.level} / ${skill.maxLevel}`,
        ),
      );
      return row;
    }),
  );
}
function renderCatalog() {
  const catalog = model.catalog;
  $("editor-catalog-total").textContent = catalog ? `${catalog.total} 项` : "—";
  $("editor-page").textContent = catalog
    ? `${model.page} / ${Math.max(1, catalog.totalPages)}`
    : "—";
  const rows = array(catalog?.items).map((item) => {
    const button = node("button", "editor-catalog-item");
    button.type = "button";
    button.dataset.catalogAbility = item.name;
    button.setAttribute(
      "aria-pressed",
      String(model.selection?.name === item.name),
    );
    const copy = node("span", "editor-catalog-copy");
    copy.append(
      node("strong", "", displayName(item)),
      node(
        "span",
        "",
        `${item.name}${item.sourceHero ? " · " + nativeHeroName(item.sourceHero) : ""}`,
      ),
    );
    button.append(
      copy,
      node(
        "span",
        "editor-catalog-meta",
        bool(item.requiresRisk) ? "需确认" : `最高 ${item.maxLevel}`,
      ),
    );
    button.addEventListener("click", () => {
      model.selection = item;
      $("editor-risk").checked = false;
      renderCatalog();
      renderSelection();
      renderControls();
    });
    return button;
  });
  $("editor-catalog-list").replaceChildren(
    ...(rows.length
      ? rows
      : [
          node(
            "p",
            "editor-empty",
            model.catalogBusy
              ? "正在读取本版本目录…"
              : catalog
                ? "没有匹配的技能。试试英文或内部名。"
                : "等待游戏返回技能目录。",
          ),
        ]),
  );
  $("editor-catalog-list").setAttribute("aria-busy", String(model.catalogBusy));
  renderControls();
}
function renderSelection() {
  const item = model.selection;
  $("editor-selection").hidden = !item;
  if (!item) return;
  $("editor-selected-name").textContent = displayName(item);
  $("editor-selected-id").textContent = item.name;
  const sources = array(item.sourceHeroes).map(nativeHeroName).filter(Boolean);
  $("editor-selected-source").textContent =
    `来源英雄：${sources.length ? sources.join(" / ") : item.sourceHero ? nativeHeroName(item.sourceHero) : "未确定"} · 最高等级 ${item.maxLevel}${bool(item.maxLevelEstimated) ? "（目录值，实际引擎确认）" : ""}`;
  $("editor-selected-note").textContent =
    text(item.dependencyNote, 700) ||
    (bool(item.requiresRisk)
      ? "此技能的额外依赖与效果需要在本机确认。"
      : "使用原生技能资源；添加结果由游戏确认。");
  $("editor-risk-row").hidden = !bool(item.requiresRisk);
  renderControls();
}
function renderControls() {
  const readable = canRead(),
    editing = canEdit();
  const status = !model.ownedRunning
    ? "未连接游戏"
    : !model.editorConnected
      ? "等待本机连接"
      : !model.editorReady
        ? "等待英雄就绪"
        : model.editable
          ? "本机编辑已就绪"
          : "当前只读";
  $("editor-connection").textContent = status;
  $("editor-connection").dataset.status = model.editorReady
    ? model.editable
      ? "ready"
      : "readonly"
    : "waiting";
  $("editor-refresh").disabled = !readable || model.busy;
  $("editor-live").hidden = !model.hero;
  $("editor-waiting").hidden = !!model.hero;
  $("editor-waiting").textContent =
    model.gameRunning && !model.ownedRunning
      ? "当前游戏由其他入口启动。请退出后通过本工具重新启动，才能建立本机编辑连接。"
      : model.ownedRunning
        ? "等待本机服务器与英雄就绪；文件已准备不代表已经连接。"
        : "准备工具后，由本工具启动本机游戏。选择英雄并等待连接，即可在此编辑技能。";
  $("editor-access").textContent = !readable
    ? "连接已中断 · 保留上次读回"
    : !model.editable
      ? "原技能只读 · 等待本机房主与作弊环境"
      : "原技能只读 · 工具新增可编辑";
  $("editor-query").disabled = !readable;
  $("editor-category").disabled = !readable;
  $("editor-search-clear").hidden = !$("editor-query").value;
  $("editor-prev").disabled = !readable || model.catalogBusy || model.page <= 1;
  $("editor-next").disabled =
    !readable ||
    model.catalogBusy ||
    !model.catalog ||
    model.page >= model.catalog.totalPages;
  const hasSkill =
    model.selection &&
    model.skills.some((skill) => skill.name === model.selection.name);
  const risk = bool(model.selection?.requiresRisk);
  $("editor-add").disabled =
    !editing ||
    !model.selection ||
    hasSkill ||
    (risk && !$("editor-risk").checked);
  $("editor-add").textContent = hasSkill
    ? "此英雄已有该技能"
    : model.pending
      ? "等待资源预载…"
      : "添加技能";
  $("editor-add-help").textContent = hasSkill
    ? "保留英雄已有技能，不能覆盖。"
    : !editing
      ? "本机连接、房主权限与作弊环境就绪后可编辑。"
      : risk && !$("editor-risk").checked
        ? "阅读依赖说明并确认后，才可尝试添加。"
        : "默认添加等级 1；等级上限以引擎确认结果为准。";
  $("editor-feedback").textContent = model.pending
    ? `正在预载 ${model.pending.ability} 的原生资源，等待游戏确认…`
    : model.message ||
      (!readable
        ? "连接中断。重新读取前，以上为最后一次游戏读回。"
        : model.editable
          ? "游戏已返回当前英雄与技能。"
          : "当前状态可查看，编辑需要本机房主与 sv_cheats。");
  $("editor-feedback").dataset.tone = model.pending ? "pending" : model.tone;
  document.querySelectorAll("[data-editor-mutation]").forEach((button) => {
    const skill = model.skills.find(
      (row) => row.name === button.dataset.ability,
    );
    const direction = button.textContent === "−" ? -1 : 1;
    button.disabled =
      !editing ||
      !skill ||
      !owned(skill) ||
      (button.dataset.editorMutation === "level" &&
        (integer(skill.level) + direction < 0 ||
          integer(skill.level) + direction >
            Math.min(100, integer(skill.maxLevel))));
  });
  renderPanel();
}
function applyState(input) {
  const state = input?.state || input;
  if (!state || typeof state !== "object") return;
  const previousRead = canRead();
  for (const key of [
    "ownedRunning",
    "editorConnected",
    "editorReady",
    "editable",
    "installed",
    "gameRunning",
  ]) {
    if (Object.hasOwn(state, key)) model[key] = bool(state[key]);
  }
  if (previousRead && !canRead()) {
    model.pending = null;
    model.panel = panelState(null);
    model.panelAction = "";
    model.busy = false;
    model.revision = -1;
    model.catalogBusy = false;
    catalogSerial++;
    clearTimeout(requestTimer);
    message("游戏连接已中断。保留上次读回，编辑已暂停。");
  }
  if (input?.editor) applyEditor(input.editor);
  renderControls();
  if (!previousRead && canRead()) {
    // A fresh local-server module may restart its revision counter.
    model.revision = -1;
    message("已连接本机服务器，正在读取英雄与技能目录。", "neutral");
    refresh().then(requestCatalog);
  }
}
function applyEditor(input) {
  const response = input?.editor || input;
  if (!response || typeof response !== "object") return false;
  const hasEpoch = Object.hasOwn(response, "runtimeEpoch");
  const epoch =
    typeof response.runtimeEpoch === "string" &&
    /^[\x20-\x7e]{1,96}$/.test(response.runtimeEpoch)
      ? response.runtimeEpoch
      : "";
  // Once the VM protocol is present, a legacy or retired VM reply cannot
  // replace its state, even if that reply carries a larger revision.
  if (
    (hasEpoch && !epoch) ||
    (model.runtimeEpoch && !epoch) ||
    retiredEpochs.has(epoch)
  )
    return false;
  const newRuntime = epoch && epoch !== model.runtimeEpoch;
  if (newRuntime) {
    const validSnapshot =
      typeof response.ok === "boolean" &&
      Number.isInteger(response.revision) &&
      response.revision >= 0 &&
      response.hero &&
      typeof response.hero === "object" &&
      !Array.isArray(response.hero) &&
      response.skills &&
      typeof response.skills === "object";
    if (!validSnapshot) return false;
    if (model.runtimeEpoch) retiredEpochs.add(model.runtimeEpoch);
    model.runtimeEpoch = epoch;
    runtimeSerial++;
    catalogSerial++;
    clearTimeout(requestTimer);
    model.revision = -1;
    model.hero = null;
    model.skills = [];
    model.selection = null;
    model.pending = null;
    model.panel = panelState(null);
    model.panelAction = "";
    model.busy = false;
    model.catalogBusy = false;
    model.catalog = null;
    model.message = "本机地图已重新载入，正在读取当前技能。";
    model.messageScope = "";
    model.tone = "neutral";
    $("editor-risk").checked = false;
  }
  const revision = integer(response.revision, -1);
  if (revision >= 0 && revision < model.revision) return false;
  if (revision >= 0) model.revision = revision;
  const previousPanel = model.panel;
  model.panel = panelState(response.panel);
  const previousPending = model.pending;
  if (
    response.hero &&
    typeof response.hero === "object" &&
    text(response.hero.unitName || response.hero.name)
  ) {
    const changed =
      model.hero?.unitName !== response.hero.unitName ||
      model.hero?.playerID !== response.hero.playerID ||
      model.hero?.map !== response.hero.map;
    model.hero = response.hero;
    $("editor-hero").textContent = nativeHeroName(
      response.hero.name || response.hero.unitName,
    );
    $("editor-context-detail").textContent = [
      text(response.hero.unitName),
      text(response.hero.map),
      response.hero.facetID !== undefined
        ? `命石 ${integer(response.hero.facetID)}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    if (changed) {
      model.selection = null;
      $("editor-risk").checked = false;
    }
  } else if (Object.hasOwn(response, "hero")) {
    model.hero = null;
    model.selection = null;
    $("editor-risk").checked = false;
  }
  if (
    response.skills &&
    (Array.isArray(response.skills) || typeof response.skills === "object")
  ) {
    model.skills = array(response.skills).filter(
      (skill) => skill && abilityID(skill.name),
    );
  }
  model.pending =
    response.pending && abilityID(response.pending.ability)
      ? response.pending
      : null;
  if (previousPending && !model.pending && bool(response.ok))
    message("游戏已完成预载并返回当前技能。", "success");
  else if (
    bool(response.ok) &&
    model.hero &&
    model.message === "已连接本机服务器，正在读取英雄与技能目录。"
  )
    message("游戏已返回当前英雄与技能。", "neutral");
  const catalog = response.catalog;
  if (
    catalog &&
    text(catalog.query) === model.query &&
    text(catalog.category) === model.category &&
    integer(catalog.page, 1) === model.page &&
    integer(catalog.pageSize) === PAGE_SIZE
  ) {
    model.catalog = {
      ...catalog,
      total: integer(catalog.total),
      totalPages: Math.max(1, integer(catalog.totalPages, 1)),
      items: array(catalog.items).filter(
        (item) => item && abilityID(item.name),
      ),
    };
    for (const item of model.catalog.items)
      if (text(item.localizedName))
        names.set(item.name, text(item.localizedName, 160));
    if (model.selection)
      model.selection =
        model.catalog.items.find(
          (item) => item.name === model.selection.name,
        ) || null;
    model.catalogBusy = false;
  }
  if (!bool(response.ok) && text(response.error))
    message(response.error, "error");
  else if (
    bool(response.ok) &&
    validPanelState(response.panel) &&
    model.messageScope === "panel" &&
    model.tone !== "error"
  ) {
    // Follow later native UI acknowledgements without replacing newer skill
    // results or errors. Epoch and revision guards above apply to this too.
    if (model.panel.ready && !previousPanel.ready)
      panelMessage("游戏内面板已由游戏确认，桌面编辑继续可用。", "success");
    else if (
      !model.panel.requested &&
      !model.panel.ready &&
      (previousPanel.requested || previousPanel.ready)
    )
      panelMessage("游戏内面板已关闭，继续使用桌面编辑。", "success");
  }
  renderSkills();
  renderCatalog();
  renderSelection();
  renderControls();
  if (newRuntime && !model.catalog && canRead()) requestCatalog();
  return true;
}
async function invoke(payload) {
  if (!bridge?.invoke) throw Error("本地编辑桥不可用，请从桌面工具打开。");
  const result = await bridge.invoke("edit", payload);
  if (result?.state) applyState(result.state);
  const accepted = result?.editor ? applyEditor(result.editor) : false;
  if (result?.ok === false && !result?.editor)
    throw Error(
      text(result.error || result.message) || "本机服务器未确认请求。",
    );
  return accepted ? result.editor : null;
}
async function refresh() {
  if (!canRead() || model.busy) return;
  try {
    await invoke({ action: "snapshot" });
  } catch (error) {
    message(error.message, "error");
  }
}
async function requestCatalog() {
  clearTimeout(searchTimer);
  if (!canRead() || composing) return;
  const query = $("editor-query").value.trim();
  if (
    new TextEncoder().encode(query).length > 160 ||
    /[\x00-\x1f\x7f]/.test(query)
  ) {
    message("搜索内容需在 160 字节以内，且不能含控制字符。", "error");
    return;
  }
  model.query = query;
  model.category = $("editor-category").value;
  if (!categories.has(model.category)) return;
  const serial = ++catalogSerial;
  model.catalogBusy = true;
  model.catalog = null;
  model.selection = null;
  $("editor-risk").checked = false;
  renderCatalog();
  renderSelection();
  try {
    await invoke({
      action: "catalog",
      query: model.query,
      category: model.category,
      page: model.page,
      pageSize: PAGE_SIZE,
    });
  } catch (error) {
    if (serial === catalogSerial) message(error.message, "error");
  } finally {
    if (serial === catalogSerial) {
      model.catalogBusy = false;
      renderCatalog();
    }
  }
}
async function mutate(action, ability, level) {
  if (!canEdit() || !abilityID(ability)) return;
  const skill = model.skills.find((item) => item.name === ability);
  if (action !== "add" && (!skill || !owned(skill))) return;
  if (
    action === "add" &&
    (skill ||
      model.selection?.name !== ability ||
      (bool(model.selection.requiresRisk) && !$("editor-risk").checked))
  )
    return;
  const payload = { action, ability };
  const serial = runtimeSerial;
  if (action === "level") payload.level = level;
  if (action === "add") {
    payload.level = integer(model.selection.maxLevel) === 0 ? 0 : 1;
    payload.allowRisk =
      bool(model.selection.requiresRisk) && $("editor-risk").checked;
  }
  model.busy = true;
  message("请求已发送，等待游戏读回…", "pending");
  const timer = setTimeout(
    () =>
      message(
        "尚未收到最终读回。请等待预载完成，或重新读取英雄；界面没有推测技能变更。",
        "pending",
      ),
    12000,
  );
  requestTimer = timer;
  try {
    const response = await invoke(payload);
    if (serial !== runtimeSerial) return;
    if (!response) message("请求尚未得到游戏状态，未确认技能变更。", "error");
    else if (!bool(response.ok))
      message(response.error || "游戏拒绝此操作，以上保留实际读回。", "error");
    else if (!response.pending)
      message("游戏已确认操作并返回当前技能。", "success");
  } catch (error) {
    if (serial === runtimeSerial) message(error.message, "error");
  } finally {
    clearTimeout(timer);
    if (serial === runtimeSerial) {
      model.busy = false;
      renderControls();
    }
  }
}
async function changePanel(mode) {
  if (!canEdit() || !model.panel.supported || !["open", "close"].includes(mode))
    return;
  const active = model.panel.requested || model.panel.ready;
  if ((mode === "open" && active) || (mode === "close" && !active)) return;
  const serial = runtimeSerial;
  model.busy = true;
  model.panelAction = mode;
  panelMessage("正在请求游戏内面板切换，等待服务器确认。", "pending");
  try {
    const response = await invoke({ action: "panel", mode });
    if (serial !== runtimeSerial) return;
    if (!response)
      panelMessage("尚未收到面板状态；桌面编辑继续可用。", "error");
    else if (!bool(response.ok))
      panelMessage(
        response.error || "游戏拒绝面板切换，桌面编辑继续可用。",
        "error",
      );
    else if (!validPanelState(response.panel))
      panelMessage("服务器尚未返回有效面板状态，未确认切换。", "error");
    else if (mode === "open")
      panelMessage(
        model.panel.ready
          ? "游戏内面板已由游戏确认，桌面编辑继续可用。"
          : "打开请求已确认，等待游戏内界面实际就绪。",
        model.panel.ready ? "success" : "pending",
      );
    else
      panelMessage(
        model.panel.requested || model.panel.ready
          ? "尚未确认游戏内面板关闭，请重新读取状态。"
          : "游戏内面板已关闭，继续使用桌面编辑。",
        model.panel.requested || model.panel.ready ? "pending" : "success",
      );
  } catch (error) {
    if (serial === runtimeSerial) panelMessage(error.message, "error");
  } finally {
    if (serial === runtimeSerial) {
      model.busy = false;
      model.panelAction = "";
      renderControls();
    }
  }
}
$("editor-panel-open").addEventListener("click", () => changePanel("open"));
$("editor-panel-close").addEventListener("click", () => changePanel("close"));
$("editor-refresh").addEventListener("click", refresh);
$("editor-query").addEventListener("compositionstart", () => {
  composing = true;
  clearTimeout(searchTimer);
});
$("editor-query").addEventListener("compositionend", () => {
  composing = false;
  model.page = 1;
  searchTimer = setTimeout(requestCatalog, 180);
});
$("editor-query").addEventListener("input", () => {
  renderControls();
  if (composing) return;
  model.page = 1;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(requestCatalog, 250);
});
$("editor-query").addEventListener("keydown", (event) => {
  if (event.isComposing || composing) return;
  if (event.key === "Enter") {
    event.preventDefault();
    model.page = 1;
    requestCatalog();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    $("editor-query").value = "";
    model.page = 1;
    requestCatalog();
  }
});
$("editor-search-clear").addEventListener("click", () => {
  $("editor-query").value = "";
  $("editor-query").focus();
  model.page = 1;
  requestCatalog();
});
$("editor-category").addEventListener("change", () => {
  model.page = 1;
  requestCatalog();
});
$("editor-prev").addEventListener("click", () => {
  if (model.page > 1) {
    model.page--;
    requestCatalog();
  }
});
$("editor-next").addEventListener("click", () => {
  if (model.catalog && model.page < model.catalog.totalPages) {
    model.page++;
    requestCatalog();
  }
});
$("editor-risk").addEventListener("change", renderControls);
$("editor-add").addEventListener("click", () => {
  if (model.selection) mutate("add", model.selection.name);
});
if (bridge?.onState && bridge?.onEditor && bridge?.invoke) {
  unstate = bridge.onState(applyState);
  uneditor = bridge.onEditor(applyEditor);
  bridge
    .invoke("inspect")
    .then(applyState)
    .catch((error) => message(error.message, "error"));
} else message("本地编辑桥不可用，请从桌面工具打开。", "error");
renderControls();
window.addEventListener("beforeunload", () => {
  clearTimeout(searchTimer);
  clearTimeout(requestTimer);
  unstate?.();
  uneditor?.();
});
