// Real isolated Electron renderer and preload, in-memory local-server readback.
// Every IPC action is intercepted. This test never starts or inspects a game.
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { _electron } = require("playwright");

(async () => {
  const root = path.resolve(__dirname, "..");
  const out = path.join(root, "test-results");
  await fs.mkdir(out, { recursive: true });
  const data = await fs.mkdtemp(path.join(out, "current-editor-ui-"));
  const harnessFile = path.join(data, "harness.cjs");
  await fs.writeFile(
    harnessFile,
    `
const {app,BrowserWindow,ipcMain,session}=require('electron');
app.disableHardwareAcceleration();
app.setPath('userData',${JSON.stringify(path.join(data, "profile"))});
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((d,c)=>c({cancel:!d.url.startsWith('file:')&&!d.url.startsWith('data:')}));
  const h={state:{root:'C:/synthetic/current-client',installed:true,build:6944,serverBuild:6944,sourceRevision:11085649,reference:{patch:'7.41f',build:6944,sourceRevision:11085649},baselineMatched:true,launchEligible:true,compatible:true,ownedRunning:false,gameRunning:false,editorConnected:false,editorReady:false,editable:false},calls:[],forbidden:[],allowLifecycle:false,revision:1,defer:false,held:[],slow:[],skills:[{name:'lina_dragon_slave',localizedName:'龙破斩',index:0,level:1,maxLevel:4,active:true,hidden:false,owned:false,readonly:true},{name:'special_bonus_unique_lina',index:10,level:0,maxLevel:1,active:true,hidden:true,owned:false,readonly:true}]};
  const items=[{name:'sven_storm_bolt',localizedName:'风暴之拳',sourceHero:'npc_dota_hero_sven',category:'ability',maxLevel:4},{name:'sven_warcry',localizedName:'战吼',sourceHero:'npc_dota_hero_sven',category:'ability',maxLevel:4},{name:'lina_light_strike_array',localizedName:'光击阵',sourceHero:'npc_dota_hero_lina',category:'ability',maxLevel:4},{name:'axe_berserkers_call',localizedName:'狂战士之吼',sourceHero:'npc_dota_hero_axe',category:'ability',maxLevel:4},{name:'tiny_avalanche',localizedName:'山崩',sourceHero:'npc_dota_hero_tiny',category:'ability',maxLevel:4},{name:'lion_finger_of_death',localizedName:'死亡之指',sourceHero:'npc_dota_hero_lion',category:'ability',maxLevel:3},{name:'orphan_innate',localizedName:'先天依赖测试',sourceHero:'',sourceHeroes:[],category:'innate',requiresRisk:true,dependencyNote:'来源英雄未知，资源无法保证预载。',maxLevel:1}];
  const editor=(extra={})=>({ok:true,revision:h.revision,...(h.runtimeEpoch?{runtimeEpoch:h.runtimeEpoch}:{}),...(h.panel?{panel:{...h.panel}}:{}),hero:{name:'npc_dota_hero_lina',unitName:'npc_dota_hero_lina',map:'dota',playerID:0,facetID:1},skills:h.skills.map(x=>({...x})),...extra});
  const catalog=p=>{let rows=items.filter(x=>(p.category==='all'||(p.category==='default'?x.category==='ability':x.category===p.category))&&(!p.query||[x.name,x.localizedName,x.sourceHero].join(' ').toLowerCase().includes(p.query.toLowerCase()))); const totalPages=Math.max(1,Math.ceil(rows.length/5));const page=Math.min(p.page||1,totalPages);return{query:p.query||'',category:p.category||'default',page,pageSize:5,total:rows.length,totalPages,items:rows.slice((page-1)*5,page*5)}};
  const win=new BrowserWindow({show:false,width:1160,height:920,webPreferences:{preload:${JSON.stringify(path.join(root, "src/current-skill-editor/preload.cjs"))},contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
  h.publish=state=>{Object.assign(h.state,state);win.webContents.send('current-skills:state',{...h.state})};
  h.push=extra=>win.webContents.send('current-skills:editor',editor(extra));
  h.releaseSlow=()=>{for(const row of h.slow.splice(0))row.resolve({ok:true,state:{...h.state},editor:editor({catalog:catalog(row.payload)})})};
  h.complete=(ok=true)=>{const held=h.held.shift();if(!held)throw Error('no held request');const p=held.payload;if(ok){if(p.action==='add')h.skills.push({name:p.ability,localizedName:items.find(x=>x.name===p.ability).localizedName,index:12,level:p.level,maxLevel:4,active:1,hidden:0,owned:1,readonly:0});if(p.action==='level')h.skills.find(x=>x.name===p.ability).level=p.level;if(p.action==='remove')h.skills=h.skills.filter(x=>x.name!==p.ability);if(p.action==='panel')h.panel={...h.panel,requested:p.mode==='open',ready:false};h.revision++}held.resolve({ok,state:{...h.state},editor:editor({ok,error:ok?'':'原技能状态变化，服务拒绝此操作。'})})};
  ipcMain.__currentEditorUI=h;
  ipcMain.handle('current-skills:invoke',(_event,action,p={})=>{
    h.calls.push({action,payload:p});
    if(action==='inspect')return{ok:true,state:{...h.state}};
    if(h.allowLifecycle&&['prepare','launch'].includes(action))return{ok:true,state:{...h.state}};
    if(action!=='edit'){h.forbidden.push(action);return{ok:false,message:'fixture refuses game actions'}};
    if(p.action==='catalog'&&p.query==='slow')return new Promise(resolve=>h.slow.push({payload:p,resolve}));
    if(p.action==='catalog')return{ok:true,state:{...h.state},editor:editor({catalog:catalog(p)})};
    if(p.action==='snapshot')return{ok:true,state:{...h.state},editor:editor()};
    return new Promise(resolve=>h.held.push({payload:p,resolve}));
  });
  await win.loadFile(${JSON.stringify(path.join(root, "src/current-skill-editor/ui/index.html"))});
});app.on('window-all-closed',()=>app.quit());
`,
  );
  const app = await _electron.launch({
    executablePath: require("electron"),
    args: [harnessFile],
    timeout: 45000,
  });
  try {
    const page = await app.firstWindow();
    const errors = [],
      external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (/^(https?|wss?):/.test(request.url())) external.push(request.url());
    });
    await page.waitForSelector("#skill-editor");
    await page.context().setOffline(true);
    const run = (fn) =>
      app.evaluate(
        ({ ipcMain }, input) =>
          ipcMain.__currentEditorUI[input.method](...(input.args || [])),
        fn,
      );
    const calls = () =>
      app.evaluate(({ ipcMain }) => ipcMain.__currentEditorUI.calls);
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    assert.equal(
      await page.locator("#editor-refresh").isDisabled(),
      true,
      "installed is not connected",
    );
    assert.equal(await page.locator("#editor-live").isVisible(), false);
    assert.equal((await calls()).filter((x) => x.action === "edit").length, 0);
    assert.equal(await page.locator(".edition span").textContent(), "制作基线");
    assert.equal(await page.locator("#reference-patch").textContent(), "7.41f");
    assert.equal(
      await page.locator("#reference-build").textContent(),
      "BUILD 6944",
    );
    assert.equal(await page.locator("#compatibility-note").isVisible(), false);
    await run({
      method: "publish",
      args: [
        {
          build: 9001,
          serverBuild: 9002,
          sourceRevision: 22000000,
          baselineMatched: false,
          compatible: true,
          launchEligible: true,
          phase: "inspected",
        },
      ],
    });
    await page.waitForFunction(
      () => document.querySelector("#build-value").textContent === "Build 9001",
    );
    assert.equal(
      await page.locator("#prepare").isDisabled(),
      false,
      "non-baseline client can prepare",
    );
    assert.equal(
      await page.locator("[data-launch=menu]").isDisabled(),
      false,
      "non-baseline client can launch",
    );
    assert.match(
      await page.locator("#version-detail").textContent(),
      /9002.*22000000/,
    );
    assert.match(
      await page.locator("#compatibility-note").textContent(),
      /可尝试运行，兼容性未验证/,
    );
    assert.equal(await page.locator("#compatibility-note").isVisible(), true);
    assert.equal(
      await page.locator("#reference-build").textContent(),
      "BUILD 6944",
      "actual build never changes the制作基线",
    );
    await app.evaluate(({ ipcMain }) => {
      ipcMain.__currentEditorUI.allowLifecycle = true;
    });
    await page.locator("#prepare").click();
    await page.waitForFunction(
      () => !document.querySelector("[data-launch=menu]").disabled,
    );
    await page.locator("[data-launch=menu]").click();
    await page.waitForFunction(
      () => !document.querySelector("#prepare").disabled,
    );
    assert.equal(
      (await calls()).filter((row) => row.action === "prepare").length,
      1,
    );
    assert.equal(
      (await calls()).filter(
        (row) => row.action === "launch" && row.payload.mode === "menu",
      ).length,
      1,
    );
    await run({
      method: "publish",
      args: [
        {
          build: null,
          serverBuild: null,
          sourceRevision: null,
          baselineMatched: false,
          launchEligible: true,
          compatible: true,
        },
      ],
    });
    await page.waitForFunction(
      () => document.querySelector("#build-value").textContent === "未知",
    );
    assert.equal(
      await page.locator("#client-status").textContent(),
      "客户端已识别",
    );
    assert.equal(
      await page.locator("#prepare").isDisabled(),
      false,
      "missing optional metadata does not block preparation",
    );
    assert.equal(
      await page.locator("[data-launch=menu]").isDisabled(),
      false,
      "missing optional metadata does not block launch",
    );
    assert.equal(await page.locator("#compatibility-note").isVisible(), true);
    await page.locator("#prepare").click();
    await page.waitForFunction(
      () => !document.querySelector("[data-launch=menu]").disabled,
    );
    await page.locator("[data-launch=menu]").click();
    await page.waitForFunction(
      () => !document.querySelector("#prepare").disabled,
    );
    assert.equal(
      (await calls()).filter((row) => row.action === "prepare").length,
      2,
      "metadata-free accepted client reaches preparation IPC",
    );
    assert.equal(
      (await calls()).filter(
        (row) => row.action === "launch" && row.payload.mode === "menu",
      ).length,
      2,
      "metadata-free accepted client reaches launch IPC",
    );
    await run({
      method: "publish",
      args: [
        {
          compatible: false,
          launchEligible: true,
          issue: "客户端 AppID 不是 570。",
        },
      ],
    });
    await page.waitForFunction(
      () => document.querySelector("#prepare").disabled,
    );
    assert.equal(
      await page.locator("[data-launch=menu]").isDisabled(),
      true,
      "wrong AppID/structure remains blocked even with inconsistent eligibility metadata",
    );
    await run({
      method: "publish",
      args: [{ compatible: true, launchEligible: false, issue: null }],
    });
    assert.equal(
      await page.locator("#prepare").isDisabled(),
      true,
      "explicit failed installation eligibility remains blocked",
    );
    await run({
      method: "publish",
      args: [
        {
          build: 9001,
          serverBuild: 9002,
          sourceRevision: 22000000,
          launchEligible: true,
          compatible: true,
          issue: null,
        },
      ],
    });
    await page.waitForFunction(
      () => !document.querySelector("#prepare").disabled,
    );
    await app.evaluate(({ ipcMain }) => {
      ipcMain.__currentEditorUI.allowLifecycle = false;
    });
    await page.locator("#client-root").fill("C:/synthetic/changed-client");
    assert.equal(
      await page.locator("#prepare").isDisabled(),
      true,
      "dirty root still requires inspection",
    );
    await page.locator("#refresh").click();
    await page.waitForFunction(
      () => !document.querySelector("#prepare").disabled,
    );
    await run({ method: "publish", args: [{ gameRunning: true }] });
    await page.waitForFunction(
      () => document.querySelector("[data-launch=menu]").disabled,
    );
    assert.equal(
      await page.locator("#prepare").isDisabled(),
      true,
      "existing game keeps preparation disabled across builds",
    );
    await run({
      method: "publish",
      args: [
        {
          gameRunning: false,
          root: "",
          build: null,
          launchEligible: false,
          compatible: false,
        },
      ],
    });
    await page.waitForFunction(
      () => document.querySelector("#build-value").textContent === "—",
    );
    assert.equal(
      await page.locator("#prepare").isDisabled(),
      true,
      "missing client still cannot prepare",
    );
    assert.equal(
      await page.locator("[data-launch=menu]").isDisabled(),
      true,
      "missing client still cannot launch",
    );
    await run({
      method: "publish",
      args: [
        {
          root: "C:/synthetic/current-client",
          build: 9001,
          launchEligible: true,
          compatible: true,
          baselineMatched: false,
        },
      ],
    });
    await page.waitForFunction(
      () => !document.querySelector("#prepare").disabled,
    );
    await run({
      method: "publish",
      args: [
        {
          ownedRunning: true,
          gameRunning: true,
          editorConnected: true,
          editorReady: true,
          editable: true,
        },
      ],
    });
    await page.waitForSelector('[data-catalog-ability="sven_storm_bolt"]');
    assert.equal(
      await page.locator("#editor-panel-open").isDisabled(),
      true,
      "legacy fixture without panel readback is unsupported",
    );
    assert.match(
      await page.locator("#editor-panel-reason").innerText(),
      /尚未提供/,
    );
    await app.evaluate(({ ipcMain }) => {
      const h = ipcMain.__currentEditorUI;
      h.panel = {
        supported: false,
        kind: "desktop",
        requested: false,
        ready: false,
        reason: "普通比赛只使用桌面，不加载游戏内面板。",
      };
      h.push();
    });
    assert.equal(await page.locator("#editor-panel-open").isDisabled(), true);
    assert.equal(await page.locator("#editor-panel-close").isDisabled(), true);
    assert.equal(
      (await calls()).filter((call) => call.payload.action === "panel").length,
      0,
    );
    await app.evaluate(({ ipcMain }) => {
      const h = ipcMain.__currentEditorUI;
      h.panel = {
        supported: true,
        kind: "demo",
        requested: false,
        ready: false,
        reason: "官方英雄试玩支持游戏内面板。",
      };
      h.push();
    });
    await page.waitForFunction(
      () => !document.querySelector("#editor-panel-open").disabled,
    );
    await page.locator("#editor-panel-open").click();
    assert.deepEqual(
      (await calls()).findLast((call) => call.payload.action === "panel")
        .payload,
      { action: "panel", mode: "open" },
    );
    assert.doesNotMatch(
      await page.locator("#editor-panel-status").innerText(),
      /已就绪/,
      "open click does not infer a ready HUD",
    );
    assert.equal(await page.locator("#editor-add").isDisabled(), true);
    await run({ method: "complete", args: [true] });
    await page.waitForFunction(() =>
      document
        .querySelector("#editor-panel-status")
        .innerText.includes("等待游戏内界面确认"),
    );
    assert.equal(await page.locator("#editor-panel-open").isDisabled(), true);
    assert.equal(await page.locator("#editor-panel-close").isDisabled(), false);
    await app.evaluate(({ ipcMain }) => {
      const h = ipcMain.__currentEditorUI;
      h.panel.ready = true;
      h.push();
    });
    await page.waitForFunction(
      () =>
        document.querySelector("#editor-panel-status").dataset.status ===
        "ready",
    );
    assert.match(
      await page.locator("#editor-feedback").innerText(),
      /面板已由游戏确认/,
      "later native ready replaces the earlier open-wait notice",
    );
    assert.equal(
      await page.locator("#editor-feedback").getAttribute("data-tone"),
      "success",
    );
    await app.evaluate(({ ipcMain }) => {
      const h = ipcMain.__currentEditorUI;
      h.panel.requested = false;
      h.panel.ready = false;
      h.push();
    });
    await page.waitForFunction(() =>
      document
        .querySelector("#editor-feedback")
        .innerText.includes("面板已关闭"),
    );
    assert.equal(await page.locator("#editor-panel-open").isDisabled(), false);
    assert.equal(await page.locator("#editor-panel-close").isDisabled(), true);
    await page.locator("#editor-panel-open").click();
    await run({ method: "complete", args: [true] });
    await page.waitForFunction(() =>
      document
        .querySelector("#editor-feedback")
        .innerText.includes("等待游戏内界面实际就绪"),
    );
    await app.evaluate(({ ipcMain }) => {
      const h = ipcMain.__currentEditorUI;
      h.panel.ready = true;
      h.push();
    });
    await page.waitForFunction(() =>
      document
        .querySelector("#editor-feedback")
        .innerText.includes("面板已由游戏确认"),
    );
    await page.locator('[data-catalog-ability="sven_storm_bolt"]').click();
    assert.equal(
      await page.locator("#editor-add").isDisabled(),
      false,
      "ready in-game panel does not disable desktop editing",
    );
    for (const field of [
      "editable",
      "editorReady",
      "editorConnected",
      "ownedRunning",
    ]) {
      await run({ method: "publish", args: [{ [field]: false }] });
      assert.equal(
        await page.locator("#editor-panel-close").isDisabled(),
        true,
        field + " gates panel controls",
      );
      await run({ method: "publish", args: [{ [field]: true }] });
      await page.waitForFunction(
        () => !document.querySelector("#editor-panel-close").disabled,
      );
    }
    await run({
      method: "push",
      args: [{ pending: { ability: "sven_storm_bolt", stage: "precache" } }],
    });
    assert.equal(
      await page.locator("#editor-panel-close").isDisabled(),
      true,
      "precache blocks panel switching",
    );
    await run({ method: "push", args: [{}] });
    await page.waitForFunction(
      () => !document.querySelector("#editor-panel-close").disabled,
    );
    await page.locator("#editor-panel-close").click();
    assert.deepEqual(
      (await calls()).findLast((call) => call.payload.action === "panel")
        .payload,
      { action: "panel", mode: "close" },
    );
    assert.doesNotMatch(
      await page.locator("#editor-panel-status").innerText(),
      /可以打开/,
      "close click does not infer an absent HUD",
    );
    await run({ method: "complete", args: [true] });
    await page.waitForFunction(
      () => !document.querySelector("#editor-panel-open").disabled,
    );
    assert.equal(await page.locator("#editor-panel-close").isDisabled(), true);
    await app.evaluate(({ ipcMain }) => {
      const h = ipcMain.__currentEditorUI;
      h.panel = {
        supported: true,
        kind: "addon",
        requested: false,
        ready: false,
        reason: "此本地游廊支持游戏内面板。",
      };
      h.push();
    });
    assert.equal(
      await page.locator("#editor-panel-open").isDisabled(),
      false,
      "supported addon is offered only after server readback",
    );
    await page.locator("#editor-panel-open").click();
    await run({ method: "complete", args: [false] });
    await page.waitForFunction(
      () => !document.querySelector("#editor-panel-open").disabled,
    );
    const panelRefusal = await page.locator("#editor-feedback").innerText();
    assert.match(panelRefusal, /拒绝/);
    assert.doesNotMatch(
      await page.locator("#editor-panel-status").innerText(),
      /已就绪/,
      "refused addon panel request never claims a ready HUD",
    );
    await page.locator('[data-catalog-ability="sven_storm_bolt"]').click();
    assert.equal(
      await page.locator("#editor-add").isDisabled(),
      false,
      "server panel refusal still permits desktop editing",
    );
    await app.evaluate(({ ipcMain }) => {
      const h = ipcMain.__currentEditorUI;
      h.panel = {
        supported: true,
        kind: "desktop",
        requested: true,
        ready: true,
        reason: "普通比赛只使用桌面。",
      };
      h.push();
    });
    assert.equal(
      await page.locator("#editor-panel-open").isDisabled(),
      true,
      "desktop kind never enables open, even with inconsistent support flags",
    );
    assert.equal(
      await page.locator("#editor-panel-status").innerText(),
      "仅桌面编辑",
    );
    assert.equal(
      await page.locator("#editor-feedback").innerText(),
      panelRefusal,
      "later panel snapshots do not erase a refusal error",
    );
    await app.evaluate(({ ipcMain }) => {
      const h = ipcMain.__currentEditorUI;
      h.panel = {
        supported: false,
        kind: "desktop",
        requested: false,
        ready: false,
        reason: "普通比赛只使用桌面。",
      };
      h.push();
    });
    assert.equal(
      await page
        .locator(
          '[data-native-skill="lina_dragon_slave"] [data-editor-mutation]',
        )
        .count(),
      0,
    );
    await page.locator("#editor-native").evaluate((el) => {
      el.open = true;
    });
    await page.locator('[data-catalog-ability="sven_storm_bolt"]').click();
    assert.equal(await page.locator("#editor-add").isDisabled(), false);
    await page.locator("#editor-add").click();
    await page.waitForFunction(
      () => document.querySelector("#editor-add").disabled,
    );
    assert.equal(
      await page.locator('[data-owned-skill="sven_storm_bolt"]').count(),
      0,
      "request is not optimistic success",
    );
    await run({ method: "complete", args: [] });
    await page.waitForSelector('[data-owned-skill="sven_storm_bolt"]');
    assert.equal(
      await page
        .locator('[data-owned-skill="sven_storm_bolt"] .editor-level-value')
        .innerText(),
      "1",
    );
    assert.match(
      await page.locator("#editor-feedback").innerText(),
      /游戏已确认/,
    );
    const skillResult = await page.locator("#editor-feedback").innerText();
    for (const active of [true, false]) {
      await app.evaluate(({ ipcMain }, active) => {
        const h = ipcMain.__currentEditorUI;
        h.panel = {
          supported: true,
          kind: "demo",
          requested: active,
          ready: active,
          reason: "官方英雄试玩支持游戏内面板。",
        };
        h.push();
      }, active);
      await page.waitForFunction(
        (active) =>
          document.querySelector("#editor-panel-status").dataset.status ===
          (active ? "ready" : "desktop"),
        active,
      );
      assert.equal(
        await page.locator("#editor-feedback").innerText(),
        skillResult,
        "native panel changes preserve a newer skill-operation result",
      );
    }
    assert.equal(
      await page.locator("#editor-native").evaluate((el) => el.open),
      true,
      "readback preserves original-skill disclosure",
    );
    assert.equal(
      await page.locator("#editor-add").isDisabled(),
      true,
      "native/owned duplicates cannot overwrite",
    );
    const lastAdd = (await calls()).findLast((x) => x.payload.action === "add");
    assert.deepEqual(lastAdd.payload, {
      action: "add",
      ability: "sven_storm_bolt",
      level: 1,
      allowRisk: false,
    });
    await page
      .locator('[data-owned-skill="sven_storm_bolt"] button[title="提升一级"]')
      .click();
    assert.equal(
      await page
        .locator('[data-owned-skill="sven_storm_bolt"] .editor-level-value')
        .innerText(),
      "1",
    );
    await run({ method: "complete", args: [] });
    await page.waitForFunction(
      () =>
        document.querySelector(
          '[data-owned-skill="sven_storm_bolt"] .editor-level-value',
        ).textContent === "2",
    );
    assert.equal(
      (await calls()).findLast((x) => x.payload.action === "level").payload
        .level,
      2,
    );
    await run({
      method: "push",
      args: [
        {
          revision: 20,
          skills: [
            {
              name: "sven_storm_bolt",
              localizedName: "风暴之拳",
              index: 12,
              level: 4,
              maxLevel: 4,
              active: 1,
              hidden: 0,
              owned: 1,
              readonly: 0,
            },
          ],
        },
      ],
    });
    await page.waitForFunction(
      () =>
        document.querySelector(
          '[data-owned-skill="sven_storm_bolt"] .editor-level-value',
        ).textContent === "4",
    );
    assert.equal(
      await page
        .locator(
          '[data-owned-skill="sven_storm_bolt"] button[title="提升一级"]',
        )
        .isDisabled(),
      true,
      "engine max level guarded",
    );
    await run({ method: "push", args: [{ revision: 19, skills: [] }] });
    assert.equal(
      await page.locator('[data-owned-skill="sven_storm_bolt"]').count(),
      1,
      "older skill readback ignored",
    );
    await app.evaluate(({ ipcMain }) => {
      ipcMain.__currentEditorUI.revision = 21;
    });
    await run({
      method: "push",
      args: [{ pending: { ability: "sven_storm_bolt", stage: "precache" } }],
    });
    await page.waitForFunction(() =>
      document
        .querySelector("#editor-feedback")
        .textContent.includes("正在预载"),
    );
    assert.equal(
      await page.locator('[data-editor-mutation="remove"]').isDisabled(),
      true,
      "pending blocks competing mutations",
    );
    await run({ method: "push", args: [{ pending: null }] });
    await page.waitForFunction(() =>
      document
        .querySelector("#editor-feedback")
        .textContent.includes("完成预载"),
    );
    await page.locator('[data-editor-mutation="remove"]').click();
    await run({ method: "complete", args: [false] });
    await page.waitForFunction(
      () => document.querySelector("#editor-feedback").dataset.tone === "error",
    );
    assert.equal(
      await page.locator('[data-owned-skill="sven_storm_bolt"]').count(),
      1,
      "server failure retains actual skill readback",
    );
    // IME must not replace the input, send syllables, or submit while composing.
    const before = (await calls()).length;
    await page.locator("#editor-query").evaluate((input) => {
      input.focus();
      input.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      input.value = "feng";
      input.dispatchEvent(
        new InputEvent("input", { bubbles: true, isComposing: true }),
      );
    });
    await page.waitForTimeout(350);
    assert.equal((await calls()).length, before);
    await page.locator("#editor-query").evaluate((input) => {
      input.value = "风暴";
      input.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      );
    });
    await page.waitForFunction(
      () => document.querySelectorAll("[data-catalog-ability]").length === 1,
    );
    assert.equal(
      await page
        .locator("#editor-query")
        .evaluate((input) => input === document.activeElement),
      true,
    );
    assert.equal(
      (await calls()).findLast((x) => x.payload.action === "catalog").payload
        .query,
      "风暴",
    );
    await page.locator("#editor-search-clear").click();
    await page.waitForFunction(
      () => document.querySelectorAll("[data-catalog-ability]").length === 5,
    );
    await page.locator("#editor-next").click();
    await page.waitForFunction(
      () => document.querySelector("#editor-page").textContent === "2 / 2",
    );
    assert.equal(
      (await calls()).findLast((x) => x.payload.action === "catalog").payload
        .pageSize,
      5,
    );
    await page.locator("#editor-category").selectOption("innate");
    await page.waitForSelector('[data-catalog-ability="orphan_innate"]');
    await page.locator('[data-catalog-ability="orphan_innate"]').click();
    assert.equal(await page.locator("#editor-add").isDisabled(), true);
    assert.match(
      await page.locator("#editor-selected-note").innerText(),
      /来源英雄未知/,
    );
    await page.locator("#editor-risk").check();
    assert.equal(await page.locator("#editor-add").isDisabled(), false);
    await page.locator("#editor-add").click();
    assert.equal(
      (await calls()).findLast((x) => x.payload.action === "add").payload
        .allowRisk,
      true,
    );
    await run({ method: "complete", args: [false] });
    await page.waitForFunction(
      () => document.querySelector("#editor-feedback").dataset.tone === "error",
    );
    // A stale catalog response cannot replace a newer query.
    await page.locator("#editor-category").selectOption("default");
    await page.locator("#editor-query").fill("slow");
    await page.waitForTimeout(350);
    await page.locator("#editor-query").fill("sven");
    await page.waitForFunction(
      () => document.querySelectorAll("[data-catalog-ability]").length === 2,
    );
    await run({ method: "releaseSlow", args: [] });
    assert.equal(
      await page.locator('[data-catalog-ability="sven_storm_bolt"]').count(),
      1,
    );
    assert.equal(await page.locator("#editor-query").inputValue(), "sven");
    await page.locator('[data-catalog-ability="sven_warcry"]').click();
    // Each authority condition must independently block mutations.
    for (const field of [
      "editable",
      "editorReady",
      "editorConnected",
      "ownedRunning",
    ]) {
      await run({ method: "publish", args: [{ [field]: false }] });
      await page.waitForFunction(
        () => document.querySelector("#editor-add").disabled,
      );
      assert.equal(
        await page.locator('[data-editor-mutation="remove"]').isDisabled(),
        true,
        field + " gates mutation",
      );
      await run({ method: "publish", args: [{ [field]: true }] });
      if (field === "editorConnected" || field === "ownedRunning") {
        await page.waitForSelector('[data-catalog-ability="sven_warcry"]');
        await page.locator('[data-catalog-ability="sven_warcry"]').click();
      }
    }
    await page.locator('[data-editor-mutation="remove"]').click();
    await run({ method: "complete", args: [true] });
    await page.waitForSelector('[data-owned-skill="sven_storm_bolt"]', {
      state: "detached",
    });
    assert.equal(
      await page.locator('[data-native-skill="lina_dragon_slave"]').count(),
      1,
      "owned deletion preserves native skills",
    );
    // Fast map reentry can keep the same process, connection and hero while
    // replacing the Lua VM. Its new revision 0 must replace the old VM state.
    await app.evaluate(({ ipcMain }) => {
      const h = ipcMain.__currentEditorUI;
      h.runtimeEpoch = "fixture_vm_first";
      h.revision = 40;
      h.panel = {
        supported: true,
        kind: "demo",
        requested: true,
        ready: true,
        reason: "旧 VM 的游戏内面板。",
      };
      h.skills.push({
        name: "sven_storm_bolt",
        localizedName: "风暴之拳",
        index: 19,
        level: 2,
        maxLevel: 4,
        active: true,
        hidden: false,
        owned: true,
        readonly: false,
      });
      h.push();
    });
    await page.waitForSelector('[data-owned-skill="sven_storm_bolt"]');
    await page.waitForSelector('[data-catalog-ability="sven_warcry"]');
    await page.locator('[data-catalog-ability="sven_warcry"]').click();
    await page.locator("#editor-add").click();
    await run({
      method: "push",
      args: [{ pending: { ability: "sven_warcry", stage: "precache" } }],
    });
    await page.waitForFunction(() =>
      document.querySelector("#editor-feedback").innerText.includes("正在预载"),
    );
    await app.evaluate(({ ipcMain }) => {
      const h = ipcMain.__currentEditorUI;
      h.runtimeEpoch = "fixture_vm_second";
      h.revision = 0;
      delete h.panel;
      h.skills = h.skills.filter((skill) => !skill.owned);
      h.push();
    });
    await page.waitForSelector('[data-owned-skill="sven_storm_bolt"]', {
      state: "detached",
    });
    assert.equal(await page.locator("#editor-selection").isVisible(), false);
    assert.equal(await page.locator("#editor-panel-open").isDisabled(), true);
    assert.equal(
      await page.locator("#editor-panel-status").innerText(),
      "仅桌面编辑",
      "new VM without panel readback clears the old ready HUD",
    );
    assert.doesNotMatch(
      await page.locator("#editor-feedback").innerText(),
      /正在预载/,
      "new VM clears old pending action",
    );
    assert.equal(
      await page.locator('[data-native-skill="lina_dragon_slave"]').count(),
      1,
      "same hero receives its new revision 0 snapshot",
    );
    assert.equal(
      await app.evaluate(({ ipcMain }) => {
        const state = ipcMain.__currentEditorUI.state;
        return state.ownedRunning && state.editorConnected && state.editorReady;
      }),
      true,
      "VM reset does not rely on an observed disconnect",
    );
    await page.waitForSelector('[data-catalog-ability="sven_warcry"]');
    await page.locator('[data-catalog-ability="sven_warcry"]').click();
    await page.locator("#editor-add").click();
    assert.equal(await page.locator("#editor-add").isDisabled(), true);
    await app.evaluate(({ ipcMain }) => {
      const h = ipcMain.__currentEditorUI;
      const old = h.held.shift();
      old.resolve({
        ok: true,
        state: { ...h.state },
        editor: {
          ok: true,
          runtimeEpoch: "fixture_vm_first",
          revision: 999,
          hero: { unitName: "npc_dota_hero_lina", map: "dota", playerID: 0 },
          skills: [{ name: "sven_storm_bolt", level: 2, owned: true }],
        },
      });
    });
    await page.waitForTimeout(80);
    assert.equal(
      await page.locator("#editor-add").isDisabled(),
      true,
      "old VM request completion cannot release the new VM mutation guard",
    );
    assert.equal(
      await page.locator('[data-owned-skill="sven_storm_bolt"]').count(),
      0,
    );
    await run({ method: "complete", args: [true] });
    await page.waitForSelector('[data-owned-skill="sven_warcry"]');
    for (const runtimeEpoch of ["fixture_vm_first", undefined]) {
      await run({
        method: "push",
        args: [
          {
            runtimeEpoch,
            revision: 999,
            panel: {
              supported: true,
              kind: "demo",
              requested: true,
              ready: true,
              reason: "迟到旧 VM 的面板。",
            },
            skills: [{ name: "sven_storm_bolt", level: 2, owned: true }],
          },
        ],
      });
      assert.equal(
        await page.locator('[data-owned-skill="sven_storm_bolt"]').count(),
        0,
      );
      assert.equal(
        await page.locator('[data-owned-skill="sven_warcry"]').count(),
        1,
      );
      assert.equal(
        await page.locator("#editor-panel-status").innerText(),
        "仅桌面编辑",
        "retired VM panel state cannot roll the active VM back",
      );
    }
    await run({ method: "push", args: [{ revision: 0, skills: [] }] });
    assert.equal(
      await page.locator('[data-owned-skill="sven_warcry"]').count(),
      1,
      "same VM still ignores lower revisions",
    );
    await run({
      method: "publish",
      args: [
        {
          ownedRunning: false,
          gameRunning: true,
          editorConnected: false,
          editorReady: false,
          editable: false,
        },
      ],
    });
    await run({
      method: "push",
      args: [{ revision: 22, hero: { name: "", unitName: "" }, skills: [] }],
    });
    await page.waitForFunction(
      () => document.querySelector("#editor-live").hidden,
    );
    assert.match(
      await page.locator("#editor-waiting").innerText(),
      /其他入口启动.*重新启动/,
    );
    await run({
      method: "publish",
      args: [
        {
          ownedRunning: true,
          gameRunning: true,
          editorConnected: true,
          editorReady: true,
          editable: true,
        },
      ],
    });
    await page.waitForSelector('[data-catalog-ability="sven_storm_bolt"]');
    assert.doesNotMatch(
      await page.locator("#editor-feedback").innerText(),
      /连接已中断/,
    );
    await page.locator('[data-catalog-ability="sven_warcry"]').click();
    await page.locator("#editor-native").evaluate((el) => {
      el.open = false;
    });
    for (const width of [1160, 850]) {
      await page.setViewportSize({ width, height: 920 });
      await page.evaluate(() => window.scrollTo(0, 0));
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        "no horizontal overflow at " + width,
      );
      await page.screenshot({
        path: path.join(out, `current-editor-${width}.png`),
        fullPage: false,
      });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.deepEqual(
      await app.evaluate(({ ipcMain }) => ipcMain.__currentEditorUI.forbidden),
      [],
    );
    console.log(
      "Current editor UI passed: real preload, server readback, native panel notice transitions, four authority gates, original readonly, levels/risk, IME, paging, VM epoch reentry and stale replies, offline and two widths.",
    );
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
