# DOTA 2 技能工作台

面向 Windows 的独立桌面工具，在本机房主的作弊环境中搜索、添加、升级和移除本工具新增的技能。界面和工具本身完全离线，游戏与 Steam 的网络需求由它们自身决定。

## 快速开始

从本仓库的 Releases 下载 Windows x64 ZIP，解压到可写文件夹，运行 `Dota Current Skill Editor.exe`。保留全部相邻文件，不要直接在压缩包内运行。发行版不需要安装 Node.js、Python 或开发工具，也不包含游戏客户端。

1. 打开正常的 Steam 客户端，使用自己的账户登录。
2. 选择 DOTA 2 安装根目录；该目录包含 `game` 子目录，点击「一键准备」。
3. 从工具启动普通本地机器人比赛，或启动主菜单后进入英雄试玩、本地作弊房间或本机游廊。选择英雄，等待桌面面板连接。
4. 搜索中文名、英文名、内部技能名或来源英雄，添加技能后调整等级；删除只作用于本工具新增的实例。
5. 退出游戏后点击「恢复工具文件」。外部修改的文件会保留，不会强制覆盖。

已手动启动的游戏不能被接管，请先退出，再从本工具启动。普通比赛使用桌面面板；英雄试玩和满足检查的本机游廊可以切换到游戏内面板。

## 使用范围

- 制作基线：**DOTA 2 7.41f / build 6944**。界面同时显示本机实际构建，0.1.2 允许更新后的客户端继续尝试，版本不同不会直接阻止使用。
- 需要本机监听服务器、作弊状态和本机真实玩家英雄。远端服务器开作弊不等于可以使用，普通在线匹配不在范围内。
- 原英雄技能、天赋和先天技能保持只读。隐藏技能、命石、调用器、复制类及附属技能可能需要额外条件，不能保证任意技能跨英雄兼容。
- 换地图、换英雄或重新启动游戏后需要重新添加。关闭桌面工具不会关闭游戏，也不会立即恢复仍在使用的文件。
- 本轮已验证后续 build 6951 的准备、连接、添加、升级和删除；未重复验收其全部技能、游廊、实际施放及跨机多人。

配置、安装清单及密封凭据保存到程序旁的 `data` 文件夹。工具目录须可写。不要上传或分享 `data`、完整游戏日志、会话密码和生成的名字索引；正在运行的会话数据不适合跨 Windows 用户迁移。

详细说明见 [使用与兼容性](docs/current-skill-editor.md)、[0.1.2 验收](docs/current-skill-editor-0.1.2-acceptance.md) 和 [更新记录](CHANGELOG.md)。二进制暂未做代码签名，发布包应核对 Releases 中的 SHA-256 校验文件。

## 源码与构建

Windows 10/11 x64，Node.js 22.12 或以上。首次安装开发依赖及准备 Electron 运行时需要网络；完成准备后，应用和打包使用本地依赖。Electron 44 的 npm 包不会在 `npm ci` 时自动安装运行时，需执行以下准备步骤；`pack` 也会先检查并准备本机运行时。

```powershell
npm ci
npm run prepare:electron
npm test
npm run build
npm start
npm run pack
```

`pack` 生成 `release/win-unpacked` 完整目录版，并附上上手、项目许可及第三方通知。发布时将这个目录的全部内容压成 ZIP，单独生成 SHA-256；本项目没有自动上传或发布功能。更新已有安装时保留旧 `data`，并先退出游戏、恢复旧工具文件。

`npm run test:ui` 运行隔离的桌面及 Panorama 模拟检查，不启动真实 DOTA 2。Lua mock 可用 Lua 5.1 或以上从仓库根目录运行：

```powershell
lua tools/current-ability/tests/skill-editor-mock.lua
```

默认构建直接核验并打包已保存的四项原创 Lua / Panorama 资源，不读取 Valve 编译工具。修改游戏内面板作者源时，可用以下命令重新生成；它要求本机保存的 **build 6944** Resource Compiler，并要求客户端与隔离的 `local` 构建目录位于同一盘。

```powershell
npm run build:resources -- "DOTA2客户端目录"
npm run verify:resources
```

编译器、Valve 基础资源、原生技能实现和本地化原文都不进入本仓库或发行包。构建工具的基线检查用于产物来源，玩家运行时的版本策略与之独立。贡献要求见 [CONTRIBUTING](CONTRIBUTING.md)。

## 许可

项目以 **PolyForm Noncommercial 1.0.0** 公开源码，限制商业使用，属于非商业源码许可。完整原文见 [LICENSE](LICENSE)。第三方依赖保持各自许可，见 [NOTICE](NOTICE) 和 `resources/licenses`。

Dota 2、Steam、Source 与 Source 2 属于 Valve。本项目独立维护，未获 Valve 背书，不分发 Valve 客户端、DLL、VPK、地图、原技能代码或 Steam 模拟器。
