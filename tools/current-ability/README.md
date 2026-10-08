# 最新版本地主机技能编辑器

独立原创服务端 Lua 与技能服务，制作及初始实测基线为本机官方客户端 **7.41f / build 6944**。**0.1.2** 允许其他游戏版本和构建继续尝试，不以版本或 build 阻断启动，界面注明基线与实际构建。官方英雄试玩保留原生 Panorama 面板，明确核实的本地游廊可主动请求游戏内面板；普通比赛使用桌面面板与会话能力桥。本目录与已验证的 7.22 工具分开，作者源不包含 Valve 技能定义、本地化名单或游戏资源。允许运行不等于其他构建已验证，仍要求本机监听服务器、作弊环境和实际英雄归属。

## 环境与权限

需要已载入地图的服务端 Lua、非专用服务器、`sv_cheats` 为 true，以及有效的 `GetListenServerHost()`。本构建该函数返回玩家 pawn，模块通过 `GetController()` 获取 DOTA 玩家控制器，再与 `PlayerResource:GetPlayer(id)`、英雄所有者核对；不假设主机 PlayerID 为 0。允许普通本地比赛、原生英雄试玩和其他具有服务端 Lua 的本地地图；允许机器人和其他真人存在，但面板和所有编辑只针对本地主机当前分配的真实英雄。拒绝克隆、风暴双雄分身、其他玩家英雄和专服。

控制台命令优先通过 `Convars:GetDOTACommandClient()` 核实调用玩家；接口不存在时使用 `GetCommandClient()`。来源须为已核实的本机控制器或对应 pawn，返回 nil 的匿名服务端命令不能编辑。图形请求也只接受该实体对，不接受英雄实体，不使用负载中的 `PlayerID` 授权。模块加载后的内部面板打开只定向本地主机，不赋予匿名调用者修改技能的权限。

模块不调用 `Activate`，不替换 Valve 入口或原 manifest，不注入 DLL，也不接受任意 Lua 文本。重复加载保留新增技能实例的归属，只重新请求此前已请求打开的独立面板；手动关闭后保持关闭，再次收到合法原生状态请求才确认 HUD 就绪。新的面板切换在资源预载中拒绝执行，不会取消桌面发起的添加，已添加技能也会保留。旧 `close` 动作仍保留取消未完成预载的兼容行为；新界面关闭使用 `panel close`。升级前已加载的不含能力桥的旧模块明确要求新 Lua VM，不能热重载到危险的旧 HUD 路线。

普通 `dota` 中动态 HUD 路线实际出现 `client.dll` 空指针崩溃，因此普通比赛加载、查询、编辑或关闭都不调用原生 HUD，也不向未挂载面板广播状态。游戏内面板只接受两种正向环境：`hero_demo_*` 地图及真实 `GameRules.herodemo` 表；或引擎实际加载的 `addoninfo.txt`，其 `IsPlayable` 为 1、`maps` 按完整 token 包含当前地图，同时具有非空有效的 `GetGameModeEntity()` 和 `DynamicHud_Create` 接口。兼容实际 flat KV 与 `AddonInfo` 包装，缺失或不匹配时保持桌面模式。地图名 `dota`、mode 存在、DLL 字符串或客户端提交的元数据均不能单独证明游廊环境；本机构建的 `GetGameMode` 等候选没有实际 Lua 接口，不作为门禁依据。

官方试玩首次加载仍自动请求原生面板；游廊必须显式选择打开，模块加载时不自动显示。游戏内面板显示也不扩大权限，仍只接受本机真实玩家来源握手及当前英雄。外部面板的输入与游戏焦点处理由启动器负责。工坊地图 `3792017961`（ALL PEAK）的游戏内面板已通过本地实际渲染、合法握手、技能添加与升级及面板切换验证；这不代表任意游廊、复杂技能或跨机多人兼容。

## 技能目录与修改范围

运行时读取 `scripts/npc/npc_abilities.txt`、`npc_heroes.txt` 和 `items.txt`。此构建的 `npc_heroes.txt` 使用 `#base` 合并独立英雄文件，原生英雄技能定义位于各英雄的 `AbilityDefinitions`；英雄定义优先于根技能目录中的同名共享项。英雄槽位和 `Facets.*.Abilities` 用于记录来源和命石依赖，不切换命石。

本构建的四个本地化原文件虽是 UTF-8，实际服务端 `LoadKeyValues` 仍报解析错误。模块因此只读取启动流程从用户本机资源提取的临时 UTF-8 名称索引 `scripts/npc/current_skill_localization_v1.txt`，不再直接读取原本地化文件。索引顶层为 `ChronicleSkillLocalization`，`Tokens` 为显示名，`SearchTokens` 为中英名称；只索引实际技能目录存在的能力 ID。中文、英文及内部名均可检索，名称不随项目分发，临时文件由后台租约恢复。

默认目录隐藏天赋、属性、先天、物品、隐藏及引擎辅助项；高级分类可查看并确认风险后尝试添加。复杂英雄技能、附属技能、先天技能和命石关联技能均标记未验证，不自动添加依赖或重建英雄状态。来源英雄按需异步预载；预载完成时重新核实主机、英雄和地图，超过 15 秒、旧 `close` 取消或上下文变化均撤销迟到操作。预载期间的新 `panel open|close` 请求会拒绝，不能因此撤销正在添加的技能。

普通 `dota` 的实机探针显示 `GameRules:GetGameModeEntity()` 可以返回 nil；不能假设普通地图拥有自定义游戏的 mode 实体。预载计时先使用已有 mode 的 `SetContextThink`，没有该对象或方法时使用已经核实的本地主机当前真实英雄，按相同官方 `(contextName, function, delay)` 签名设置唯一工具计时。不会改写默认 `SetThink`，计时注册前再次核实本机上下文；注册失败则取消迟到添加。

只添加本机构建存在的原生技能，不覆盖同名技能。现代 `GetAbilityCount()` 是当前列表长度，不能据无空槽判定引擎容量已满；已有空位或当前长度小于本工具 64 项检查边界时，可以请求引擎添加并核对实际新增实例。64 项是检查边界，不是引擎可用容量的承诺。只能升级或删除本模块自己添加、仍能精确核对的技能句柄；原技能、原天赋和原先天技能只读。等级范围以原生 `GetMaxLevel()` 和读回为准。操作前后核对其他技能的原始枚举槽位、句柄、`GetAbilityIndex()`、等级、隐藏及启用状态；不会将部分辅助技能返回的索引 0 当作其原始槽位。原槽变化或额外未知技能出现时报告失败，不声称已恢复原状态，不笼统清理 modifier 或召唤物。

若引擎返回的确切新技能挤入已占用槽位，新增操作仍判失败且不升级。只为这个能严格证明归属的新句柄保留 `partial` 清理权限，不接管位移的原技能、附属技能或同名替换句柄。清理后按添加前基线核对原技能；只有原生删除自身新增项自然恢复该基线才报告成功，不由工具搬移或改写原技能。

## 协议与命令

| 项目         | 名称                                                               |
| ------------ | ------------------------------------------------------------------ |
| 模块全局     | `__current_skill_editor_v1`                                        |
| 请求事件     | `current_skill_ui_request`                                         |
| 响应事件     | `current_skill_ui_state`                                           |
| 独立 HUD ID  | `current_skill_editor`                                             |
| 布局资源     | `file://{resources}/layout/custom_game/current_ability_editor.xml` |
| 已加载标记   | `CURRENT_SKILL_EDITOR_LOADED`                                      |
| 真正就绪标记 | `CURRENT_SKILL_EDITOR_UI_READY`                                    |
| 外部桥命令   | `current_skill_bridge`                                             |
| 外部桥回应   | `CURRENT_SKILL_BRIDGE_REPLY <requestId> <json>`                    |

请求动作固定为 `snapshot`、`catalog`、`add`、`level`、`remove`、`panel`、`close`，沿用独立编辑器的 `requestId`、`revision`、`hero`、`skills`、`catalog` 和 `pending` 字段。`panel` 只接受 `mode: "open"` 或 `"close"`。正常状态的 `panel` 字段包含 `supported`、`kind`（`demo`、`addon` 或 `desktop`）、`requested`、`ready` 和 `reason`，分别说明原生支持环境、加载请求及真正客户端握手状态；桥接快照不会制造 `ready`。

额外的 `runtimeEpoch` 标识当前 Lua 实例，使退出再进入地图后重置的 revision 能与旧消息区分；同一实例重载保留标识。标识优先来自 `DoUniqueString` 的固定工具前缀，兼容回退只使用有界非秘密时间、随机数及本地序号，结果为至多 96 字节的 ASCII，不包含玩家身份、密码或会话凭据，不用于授权。所有状态、异步最终回应、拒绝及编码失败回应均携带标识。目录默认每页五项，首次技能快照前先初始化目录名称和先天属性。只有合法来源首次请求已打开面板的状态，才打印 UI 就绪标记；`CURRENT_SKILL_EDITOR_PANEL requested` 仅说明已请求加载。

| 命令                                              | 用法                                             |
| ------------------------------------------------- | ------------------------------------------------ |
| `current_skill_panel`                             | 切换面板；可指定 `open` 或 `close`               |
| `current_skill_status` / `current_skill_snapshot` | 查看本机英雄与技能槽状态                         |
| `current_skill_catalog` / `current_skill_search`  | `[搜索词] [分类] [页码]`，中文词在控制台加双引号 |
| `current_skill_add`                               | `<内部名> [等级] [risk]`                         |
| `current_skill_level`                             | `<本工具新增内部名> <等级>`                      |
| `current_skill_remove`                            | `<本工具新增内部名>`                             |

分类为 `default`、`all`、`hidden`、`talent`、`innate`、`item`、`generic`、`complex`。所有命令注册为 `FCVAR_CHEAT`；命令与 UI 使用同一修改服务。

## 外部面板能力桥

管理器为每轮会话生成随机 32 字节、编码为 64 个十六进制字符的能力凭据，通过临时文件 `scripts/npc/current_skill_session_v1.txt` 提供给 Lua。文件顶层为 `CurrentSkillSession`，字段为 `Capability`；凭据不随项目分发、不加入回复，也不由浏览器页面保存。管理器同时必须核实本程序拥有的 PID、可执行文件、创建时间和 TCP 监听归属，并使用独立随机原生控制密码。

`M.BridgeRequest(capability, requestId, action, args)` 读取该固定文件并校验能力凭据，再核实本地主机、作弊状态和真实英雄。匿名服务端命令只有凭据匹配才能使用此桥；两个命令来源接口的任一明确远端来源均拒绝，即使持有凭据也不能越权。负载 PlayerID、英雄实体、任意代码或路径均不参与授权。

固定控制台格式如下，能力凭据和编号只由管理器生成，不让用户手填；编号为 1–48 字节 ASCII 字母、数字、下划线或连字符。

```text
current_skill_bridge <capability> <requestId> snapshot
current_skill_bridge <capability> <requestId> catalog <category> <page> <pageSize> <queryHex或->
current_skill_bridge <capability> <requestId> add <ability> <level或-> <risk0或1>
current_skill_bridge <capability> <requestId> level <ability> <level>
current_skill_bridge <capability> <requestId> remove <ability>
current_skill_bridge <capability> <requestId> panel open
current_skill_bridge <capability> <requestId> panel close
current_skill_bridge <capability> <requestId> close
```

搜索词按 UTF-8 字节转为十六进制，空词使用 `-`，避免原生控制台拆分中文；参数始终按数据解析，不求值 Lua 或 JSON。桥回应沿用原状态结构，JSON 单行且限制为 60000 字节，另有字符串、节点与深度边界。异步添加先回 `pending`，预载完成或失败仍使用原编号；只有旧 `close` 取消时才向原未完成编号返回取消失败。新的 `panel` 在预载期间拒绝切换，保持原添加请求。桥快照不会打印原生 `UI_READY`。

## 验证状态

作者源通过 Lua 5.1 语法检查；独立 Fengari mock **3329 次断言**覆盖现代 pawn/控制器身份、远端与匿名拒绝、能力凭据和固定命令、普通地图不调用 HUD、无 mode 实体的英雄计时、同编号异步回应及取消、Lua 实例标识与重载保留、JSON 转义及长度/非有限数边界、现代技能定义、先天与命石风险、空槽归属、动态列表追加和移除、异常位移拒绝及确切部分实例清理、辅助技能索引 0、原始槽位变化拒绝、等级和原状态保持、中英名称检索，以及真实 flat/wrapped AddonInfo 形状、精确地图匹配、无效 mode/HUD 拒绝、显式游廊面板请求、本机握手、手动关闭后重载及预载期间切换拒绝。

模拟测试不证明原生效果或跨机多人。build 6944 已另外实测普通比赛的桌面编辑、官方试玩的真实 Panorama 握手与编辑，以及风暴之拳和时间锁定的添加、升级、实际效果与删除；原技能状态保持。退出后重进试玩的模块恢复也已通过，范围与记录见 [当前版编辑器说明](../../docs/current-skill-editor.md)。

0.1.1 完成了以下有限范围的本机验收：

- ALL PEAK `3792017961` 的 `dota` 地图中，点击“游戏内”后真实 HUD 握手得到 `ready=true`；原生 GUI 添加风暴之拳至 1 级、升级至 2 级，原生关闭按钮关闭后，桌面仍读到同一新增技能为 2 级。第二轮独立 Lua VM 另验证了跨面板删除，新增列表清空，23 项原技能保持只读。
- 该游廊测试错过了正常选人倒计时，测试者使用私有异步预载及 `SetAssignedHeroEntity` 步骤建立真实归属英雄，才进入上述验收。此步骤未加入公开模块，也未放宽主机或英雄归属检查；不能将其记录为游廊原生选人流程通过。
- 普通比赛通过原生选人取得斧王，20 项原技能保持只读，游戏内面板状态为不支持且按钮禁用；桌面添加技能至 2 级及删除通过，未调用原生 HUD。
- 从官方主界面正常启动斧王英雄试玩，`hero_demo_main` 自动打开原生面板并完成握手；原生关闭、桌面重新打开并再次握手、桌面关闭均通过，22 项原技能保持只读，新增列表为空。

以上不保证游廊覆盖的同名技能具有普通比赛数值或完整效果，也不扩展为全部地图、全部英雄及跨机多人通过。
