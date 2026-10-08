# 参与维护

提交前先确认问题可在本机房主的作弊环境复现。问题报告应写明工具版本、实际客户端 build、普通比赛/英雄试玩/游廊环境、操作步骤、预期与实际结果；只提供去除身份和凭据后的必要片段。

作者源位于 `src/current-skill-editor` 和 `tools/current-ability`，共享路径工具位于 `src/backend`。`src/ui/assets`、`release`、`local`、`data` 与 `test-results` 是生成物或私人状态，不得提交。游戏资源、原始 KV、本地化名字索引、日志、转储和密码也不得提交。

```powershell
npm ci
npm run prepare:electron
npm test
npm run build
npm run test:ui
```

服务、身份与控制通道测试使用合成客户端和回包；不要在 CI 中启动真实游戏、操作 Steam 注册表、终止外部进程或使用玩家凭据。Lua 修改还应运行 `lua tools/current-ability/tests/skill-editor-mock.lua`，并单独检查 Lua 5.1 语法。

修改 Panorama 作者源后需使用匹配基线的本机编译器生成对应原创产物，核对 `manifest.json`；不要只改作者源而沿用旧编译资源。编译工具及 Valve 基础资源留在贡献者本机。

请保持固定命令和参数语法、进程 PID/路径/创建时间检查、文件归属租约、密封凭据和本机玩家权限边界。禁止增加远端控制、任意 Lua 执行、自动清理不归本工具所有的文件，或将版本放开解释成所有后续构建兼容。

保持应用离线，不增加遥测、账号认证、自动更新或运行时 CDN。新增能力须记录实际测试范围；模拟检查不能代替实机施放、完整地图或多人验收。第三方依赖需要保留原通知，项目许可保持 PolyForm Noncommercial 1.0.0 原文。
