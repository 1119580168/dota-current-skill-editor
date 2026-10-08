const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  session,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createService } = require("./service.cjs");
const BASE = path.resolve(__dirname, "../..");
app.setName("Dota Current Skill Editor");
const data = app.isPackaged
  ? path.join(path.dirname(process.execPath), "data")
  : path.join(BASE, "local/current-editor-data");
// Electron requires an existing userData directory before changing its path.
fs.mkdirSync(data, { recursive: true });
const dataStat = fs.lstatSync(data);
if (!dataStat.isDirectory() || dataStat.isSymbolicLink())
  throw Error("工具数据目录必须是实际文件夹");
app.setPath("userData", data);
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  let win, service, timer;
  const publish = (state) => {
    if (win && !win.isDestroyed())
      win.webContents.send("current-skills:state", state);
  };
  const publishEditor = (editor) => {
    if (win && !win.isDestroyed())
      win.webContents.send("current-skills:editor", editor);
  };
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      let payloadBase = BASE;
      if (payloadBase.endsWith(".asar")) payloadBase += ".unpacked";
      service = createService({
        data,
        payload: path.join(payloadBase, "resources/current-skill-editor/6944"),
        notify: publish,
        notifyEditor: publishEditor,
      });
      session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
        callback({
          cancel:
            !details.url.startsWith("file:") &&
            !details.url.startsWith("data:"),
        }),
      );
      ipcMain.handle(
        "current-skills:invoke",
        async (event, action, payload = {}) => {
          if (
            !win ||
            event.sender !== win.webContents ||
            ![
              "inspect",
              "selectRoot",
              "prepare",
              "launch",
              "restore",
              "openFolder",
              "edit",
            ].includes(action)
          )
            return { ok: false, message: "无效操作" };
          try {
            if (action === "selectRoot") {
              const pick = await dialog.showOpenDialog(win, {
                properties: ["openDirectory"],
                title: "选择包含 game 文件夹的 DOTA2 客户端",
              });
              if (!pick.canceled) await service.selectRoot(pick.filePaths[0]);
            } else if (
              action === "inspect" &&
              typeof payload.root === "string" &&
              payload.root &&
              payload.root !== (await service.inspect()).root
            )
              await service.selectRoot(payload.root);
            else if (action === "launch") await service.launch(payload.mode);
            else if (action === "openFolder")
              await shell.openPath((await service.inspect()).root);
            else if (action === "prepare") await service.prepare();
            else if (action === "restore") await service.restore();
            else if (action === "edit") {
              const editor = await service.edit(payload);
              return {
                ok: editor.ok === true,
                message: editor.error || "",
                editor,
                state: await service.inspect(),
              };
            }
            return {
              ok: true,
              state: await service.inspect(),
              message:
                action === "prepare"
                  ? "工具已准备。从这里启动客户端，选定英雄后桌面面板会自动连接。"
                  : action === "restore"
                    ? "工具文件已恢复。"
                    : action === "launch"
                      ? payload.mode === "demo"
                        ? "请在英雄详情中选择试玩；桌面编辑面板会自动连接。"
                        : "游戏已启动；进入本地作弊地图并选定英雄后，桌面面板会自动连接。"
                      : "",
            };
          } catch (e) {
            return {
              ok: false,
              message: e.message,
              state: await service.inspect().catch(() => null),
            };
          }
        },
      );
      win = new BrowserWindow({
        show: false,
        width: 1160,
        height: 920,
        minWidth: 850,
        minHeight: 660,
        backgroundColor: "#10161c",
        title: "DOTA2 · 现代技能编辑器",
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event, url) => {
        if (url !== win.webContents.getURL()) event.preventDefault();
      });
      await win.loadFile(path.join(__dirname, "ui/index.html"));
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
      }
      let polling = false;
      timer = setInterval(async () => {
        if (polling) return;
        polling = true;
        try {
          const state = await service.inspect();
          publish(state);
          if (state.installed && state.ownedRunning)
            await service.edit({ action: "snapshot" }).catch(() => {});
        } catch {
        } finally {
          polling = false;
        }
      }, 4000);
      timer.unref();
    })
    .catch((e) => {
      dialog.showErrorBox("技能编辑器无法启动", e.message);
      app.quit();
    });
  app.on("window-all-closed", () => {
    if (timer) clearInterval(timer);
    app.quit();
  });
}
