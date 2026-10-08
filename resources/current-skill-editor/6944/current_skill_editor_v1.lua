-- Original Dota Chronicle current-client server editor, Lua 5.1-compatible.
-- Intended runtime: local listen-host real hero + sv_cheats, modern build 6944.
-- Reads the user's runtime KV; does not embed or rewrite Valve game data.

local KEY = "__current_skill_editor_v1"
if _G[KEY] then
    local existing = _G[KEY]
    if type(existing.BridgeRequest) ~= "function" or type(existing.runtimeEpoch) ~= "string"
        or #existing.runtimeEpoch < 1 or #existing.runtimeEpoch > 96
        or not existing.runtimeEpoch:match("^[a-zA-Z0-9_%-]+$") then
        print("CURRENT_SKILL_REFUSED old service requires a fresh Lua VM; runtime epoch or safe bridge absent")
        return existing
    end
    -- Preserve added-instance ownership. A deliberate reload only re-arms our
    -- own HUD handshake; it must not silently assert that old UI is still alive.
    print("CURRENT_SKILL_REUSE existing instance; new source needs a fresh Lua VM")
    print("CURRENT_SKILL_EDITOR_LOADED v1 reused; ownership retained; UI requires a new snapshot")
    if type(existing.RearmPanel) == "function" then
        local ok, reason = existing.RearmPanel()
        if not ok then print("CURRENT_SKILL_REFUSED " .. tostring(reason)) end
    else
        print("CURRENT_SKILL_REFUSED existing service requires a fresh Lua VM")
    end
    return existing
end

local M = { version = 1, profile = "current-6944", bridgeVersion = 1 }
local REQUEST = "current_skill_ui_request"
local RESPONSE = "current_skill_ui_state"
local HUD = "current_skill_editor"
local LAYOUT = "file://{resources}/layout/custom_game/current_ability_editor.xml"
local directory, ordered, heroDefinitions = nil, nil, nil
local localizedSearch = {}
local ownedByHero, cachedHeroes, registered = {}, {}, {}
local pending, listener, panelHost, panelMap = nil, nil, nil, nil
local panelReady = false
local panelRequested = false
local generation, revision = 0, 0
local bridgeRequests = {}
local view = { query = "", category = "default", page = 1, pageSize = 5 }
local categories = { default = true, all = true, hidden = true, talent = true,
    item = true, generic = true, innate = true, complex = true }

local function log(marker, text)
    print("CURRENT_SKILL_" .. marker .. (text and (" " .. tostring(text)) or ""))
end

local function call(object, name, ...)
    if object == nil then return false, "missing object: " .. name end
    local ok, method = pcall(function() return object[name] end)
    if not ok or type(method) ~= "function" then return false, "missing method: " .. name end
    return pcall(method, object, ...)
end

local function valid(handle)
    if handle == nil then return false end
    local ok, null = call(handle, "IsNull")
    return ok and null == false
end

local function integer(value, minimum, maximum)
    if type(value) ~= "number" and type(value) ~= "string" then return nil end
    local n = tonumber(value)
    if not n or n ~= math.floor(n) or n < minimum or n > maximum then return nil end
    return n
end

local function newRuntimeEpoch()
    if type(DoUniqueString) == "function" then
        local ok, value = pcall(DoUniqueString, "current_skill_epoch")
        if ok and type(value) == "string" and #value >= 1 and #value <= 96
            and value:match("^[a-zA-Z0-9_%-]+$") then return value end
    end
    -- This is a non-secret state identity, not a capability. A bounded local
    -- serial also makes repeated fixture loads distinct without engine APIs.
    -- Use engine wall-clock/randomness when available, then Lua randomness;
    -- no player name, address, path, password, or session capability is used.
    local serialKey = "__current_skill_runtime_epoch_serial_v1"
    local serial = (integer(_G[serialKey], 0, 1073741822) or 0) + 1
    _G[serialKey] = serial
    local clock = 0
    for _, name in ipairs({ "RealTime", "Time" }) do
        if type(_G[name]) == "function" then
            local ok, value = pcall(_G[name])
            if ok and type(value) == "number" and value == value and value >= 0 and value < math.huge then
                clock = math.floor(value * 1000) % 1073741823
                break
            end
        end
    end
    local parts = {}
    for index = 1, 3 do
        local value
        if type(RandomInt) == "function" then
            local ok, candidate = pcall(RandomInt, 0, 1073741823)
            if ok then value = integer(candidate, 0, 1073741823) end
        end
        if value == nil and type(math.random) == "function" then
            local ok, candidate = pcall(math.random, 0, 1073741823)
            if ok then value = integer(candidate, 0, 1073741823) end
        end
        parts[index] = string.format("%x", value or (serial * index + clock) % 1073741823)
    end
    return "current_skill_epoch_f_" .. serial .. "_" .. clock .. "_" .. table.concat(parts, "_")
end
local runtimeEpoch = newRuntimeEpoch()
M.runtimeEpoch = runtimeEpoch

local function checked(value)
    return value == true or value == 1 or value == "1" or value == "true"
end

local function abilityName(name)
    return type(name) == "string" and #name <= 128 and name:match("^[a-z][a-z0-9_]*$") ~= nil
end

local function hostGuard(cheatsRequired, checkCommandIssuer)
    if type(IsServer) ~= "function" or not IsServer() then return nil, "需要服务端 Lua。" end
    if type(IsDedicatedServer) ~= "function" or IsDedicatedServer() then return nil, "仅允许本机监听服务器。" end
    if cheatsRequired then
        local ok, enabled = call(Convars, "GetBool", "sv_cheats")
        if not ok or enabled ~= true then return nil, "需要启用本地试玩作弊。" end
    end
    if type(GetListenServerHost) ~= "function" then return nil, "缺少本机玩家接口。" end
    local ok, pawn = pcall(GetListenServerHost)
    if not ok or not valid(pawn) then return nil, "本机玩家尚未就绪。" end
    -- Source 2 now exposes the local player pawn here, not the DOTA
    -- controller. Follow the engine-owned relationship; never guess ID 0.
    local controllerOK, controller = call(pawn, "GetController")
    local host = controllerOK and valid(controller) and controller or nil
    if not host then return nil, "本机玩家控制器尚未就绪。" end
    local idOK, playerID = call(host, "GetPlayerID")
    local playerOK, player = call(PlayerResource, "GetPlayer", playerID)
    if not idOK or integer(playerID, 0, 63) == nil or not playerOK or player ~= host then
        return nil, "本机玩家控制器身份读回不一致。"
    end
    if checkCommandIssuer then
        -- A server-console nil issuer is not authorization in multiplayer.
        -- Prefer the DOTA player handle where the current API provides it.
        local methodOK, method = pcall(function() return Convars.GetDOTACommandClient end)
        local issuerMethod = methodOK and type(method) == "function" and "GetDOTACommandClient" or "GetCommandClient"
        local issuerOK, issuer = call(Convars, issuerMethod)
        if not issuerOK or (issuer ~= host and issuer ~= pawn) then return nil, "仅本机玩家本人可执行此命令；服务端匿名命令不授权编辑。" end
    end
    return host, nil, pawn
end

local function context(checkCommandIssuer)
    local host, reason = hostGuard(true, checkCommandIssuer)
    if not host then return nil, reason end
    if GameRules == nil then return nil, "游戏规则尚未就绪。" end
    local mapOK, mapName = false, nil
    if type(GetMapName) == "function" then mapOK, mapName = pcall(GetMapName) end
    if not mapOK or type(mapName) ~= "string" or #mapName > 128
        or not mapName:match("^[%w_%-]+$") then return nil, "需要已载入的本地游戏地图。" end
    -- No single-human restriction: bots and additional humans may be present.
    -- Every edit remains bound to the listen host's assigned real hero.
    local heroOK, hero = call(host, "GetAssignedHero")
    local realOK, real = call(hero, "IsRealHero")
    local idOK, playerID = call(host, "GetPlayerID")
    local ownerOK, ownerID = call(hero, "GetPlayerOwnerID")
    local controllerOK, owner = call(hero, "GetPlayerOwner")
    if not heroOK or not valid(hero) or not realOK or not real
        or not idOK or integer(playerID, 0, 63) == nil or not ownerOK or playerID ~= ownerID
        or not controllerOK or owner ~= host then return nil, "本机英雄尚未就绪。" end
    local cloneOK, clone = call(hero, "IsClone")
    if cloneOK and clone then return nil, "不能编辑克隆英雄。" end
    local doubleOK, double = call(hero, "IsTempestDouble")
    if doubleOK and double then return nil, "不能编辑风暴双雄分身。" end
    local playerOK, player = call(PlayerResource, "GetPlayer", playerID)
    if not playerOK or player ~= host then return nil, "本机玩家身份读回不一致。" end
    return { host = host, hero = hero, playerID = playerID, map = mapName }
end

local function resolveContext(candidate)
    if candidate == nil then return context(true) end
    local current, reason = context(false)
    if not current then return nil, reason end
    if type(candidate) ~= "table" or candidate.host ~= current.host
        or candidate.hero ~= current.hero or candidate.map ~= current.map
        or candidate.playerID ~= current.playerID then return nil, "本机上下文已改变。" end
    return current
end

local function contextThink(ctx, name, callback, delay)
    local current, reason = resolveContext(ctx)
    if not current then return false, reason end
    -- Ordinary modern dota maps can have no custom game-mode entity at all.
    -- The native host's current real hero exposes the same verified
    -- (contextName, function, delay) API. Never replace its default Think.
    local modeOK, mode = call(GameRules, "GetGameModeEntity")
    local methodOK, method = pcall(function() return mode and mode.SetContextThink end)
    local thinker = modeOK and methodOK and type(method) == "function" and mode or current.hero
    local ok, errorMessage = call(thinker, "SetContextThink", name, callback, delay)
    if ok then log("TIMER", thinker == current.hero and "hero:SetContextThink" or "mode:SetContextThink") end
    -- Do not retry a throwing registration on another entity: a partially
    -- registered callback would otherwise be duplicated.
    return ok, errorMessage
end

local function runtimeKV(path, root)
    if type(LoadKeyValues) ~= "function" then return nil end
    local ok, data = pcall(LoadKeyValues, path)
    if not ok or type(data) ~= "table" then return nil end
    if type(data[root]) == "table" then return data[root] end
    return data
end

local function nativeDemo(ctx)
    return ctx ~= nil and GameRules ~= nil and type(GameRules.herodemo) == "table"
        and type(ctx.map) == "string" and ctx.map:match("^hero_demo_") ~= nil
end

local function nativePanelSupport(ctx)
    local unavailable = { supported = false, kind = "desktop", reason = "普通比赛使用桌面面板；尚未核实原生游廊界面环境。" }
    if ctx == nil then
        unavailable.reason = "本机英雄或已载入地图尚未就绪。"
        return unavailable
    end
    local createOK, create = pcall(function() return CustomUI and CustomUI.DynamicHud_Create end)
    if not createOK or type(create) ~= "function" then
        unavailable.reason = "此环境没有原生动态面板接口。"
        return unavailable
    end
    if nativeDemo(ctx) then return { supported = true, kind = "demo", reason = "" } end
    -- Read the engine's currently mounted addon metadata. The base map name,
    -- a mode entity alone, and any client payload are not addon evidence.
    local info = runtimeKV("addoninfo.txt", "AddonInfo")
    if type(info) ~= "table" or (info.IsPlayable ~= 1 and info.IsPlayable ~= "1")
        or type(info.maps) ~= "string" or #info.maps < 1 or #info.maps > 4096 then return unavailable end
    local matches, count = false, 0
    for token in info.maps:gmatch("[^%s,]+") do
        count = count + 1
        if count > 128 or #token > 128 or not token:match("^[%w_%-]+$") then return unavailable end
        if token == ctx.map then matches = true end
    end
    if not matches then
        unavailable.reason = "当前地图不在已加载游廊的 maps 列表中。"
        return unavailable
    end
    local modeOK, mode = call(GameRules, "GetGameModeEntity")
    if not modeOK or not valid(mode) then
        unavailable.reason = "已加载游廊尚无有效自定义游戏规则实体。"
        return unavailable
    end
    return { supported = true, kind = "addon", reason = "" }
end

local function panelState(ctx)
    local result = nativePanelSupport(ctx)
    result.requested = result.supported and ctx ~= nil and panelRequested
        and panelHost == ctx.host and panelMap == ctx.map or false
    result.ready = result.requested and panelReady or false
    return result
end

local function jsonEncode(value)
    local chunks, bytes, nodes = {}, 0, 0
    local arrayFields = { skills = true, items = true, associatedAbilities = true, sourceHeroes = true }
    local function append(chunk)
        bytes = bytes + #chunk
        if bytes > 60000 then error("bridge reply exceeds 60000 bytes") end
        table.insert(chunks, chunk)
    end
    local function quote(text)
        if #text > 4096 then error("bridge string exceeds bound") end
        append('"')
        append((text:gsub('[%z\1-\31\\"]', function(character)
            if character == '"' then return '\\"' end
            if character == '\\' then return '\\\\' end
            return string.format("\\u%04x", character:byte())
        end)))
        append('"')
    end
    local encode
    encode = function(item, depth, field)
        nodes = nodes + 1
        if nodes > 4096 or depth > 10 then error("bridge structure exceeds bound") end
        local kind = type(item)
        if kind == "nil" then append("null")
        elseif kind == "boolean" then append(item and "true" or "false")
        elseif kind == "number" then
            if item ~= item or item == math.huge or item == -math.huge then error("nonfinite bridge number") end
            append(tostring(item))
        elseif kind == "string" then quote(item)
        elseif kind == "table" then
            if arrayFields[field] then
                if #item > 256 then error("bridge array exceeds bound") end
                append("[")
                for index = 1, #item do
                    if index > 1 then append(",") end
                    encode(item[index], depth + 1)
                end
                append("]")
            else
                local keys = {}
                for key in pairs(item) do
                    if type(key) ~= "string" then error("bridge object key must be text") end
                    table.insert(keys, key)
                end
                if #keys > 128 then error("bridge object exceeds bound") end
                table.sort(keys)
                append("{")
                for index, key in ipairs(keys) do
                    if index > 1 then append(",") end
                    quote(key) append(":") encode(item[key], depth + 1, key)
                end
                append("}")
            end
        else error("unsupported bridge value") end
    end
    local ok, reason = pcall(encode, value, 0)
    if not ok then return nil, reason end
    return table.concat(chunks)
end

local function bridgeReply(requestId, result)
    result.runtimeEpoch = runtimeEpoch
    local json = jsonEncode(result)
    if not json then
        json = '{"requestId":"' .. requestId .. '","runtimeEpoch":"' .. runtimeEpoch .. '","ok":false,"error":"bridge reply encoding failed"}'
    end
    print("CURRENT_SKILL_BRIDGE_REPLY " .. requestId .. " " .. json)
    return result
end

local function hasFlag(flags, flag)
    return type(flags) == "string" and flags:find(flag, 1, true) ~= nil
end

local function complexFamily(name)
    for _, prefix in ipairs({ "invoker_", "morphling_", "rubick_", "meepo_", "lone_druid_", "arc_warden_" }) do
        if name:sub(1, #prefix) == prefix then return true end
    end
    return false
end

local function loadDirectory()
    if directory then return true end
    local abilities = runtimeKV("scripts/npc/npc_abilities.txt", "DOTAAbilities")
    local heroes = runtimeKV("scripts/npc/npc_heroes.txt", "DOTAHeroes")
    if not abilities or not heroes then return false, "无法读取本机技能或英雄 KV。" end
    local items = runtimeKV("scripts/npc/items.txt", "DOTAAbilities") or {}
    local definedNames = {}
    for name, definition in pairs(abilities) do
        if abilityName(name) and type(definition) == "table" then definedNames[name] = true end
    end
    for name, definition in pairs(items) do
        if abilityName(name) and type(definition) == "table" then definedNames[name] = true end
    end
    for _, hero in pairs(heroes) do
        if type(hero) == "table" and type(hero.AbilityDefinitions) == "table" then
            for name, definition in pairs(hero.AbilityDefinitions) do
                if abilityName(name) and type(definition) == "table" then definedNames[name] = true end
            end
        end
    end
    -- Even these modern UTF8 originals fail the native generic KV loader.
    -- Read only a runtime-generated UTF8 name index owned by the launcher;
    -- never parse the four native localization files from server Lua.
    local localization = runtimeKV("scripts/npc/current_skill_localization_v1.txt", "ChronicleSkillLocalization")
    local tokens = {}
    if localization and type(localization.Tokens) == "table" then
        for name, value in pairs(localization.Tokens) do
            if definedNames[name] and type(value) == "string" then tokens[name] = value end
        end
    end
    if localization and type(localization.SearchTokens) == "table" then
        for name, value in pairs(localization.SearchTokens) do
            if definedNames[name] and type(value) == "string" then localizedSearch[name] = value:lower() end
        end
    end
    local localizedCount = 0
    for _ in pairs(tokens) do localizedCount = localizedCount + 1 end
    log("LOCALIZATION", "runtime_tokens=" .. localizedCount .. "; source=temporary UTF8 name index")
    local sourceHeroes, heroAbilities, facetSkills = {}, {}, {}
    local function source(name, skill)
        if not abilityName(skill) then return end
        sourceHeroes[skill] = sourceHeroes[skill] or {}
        for _, current in ipairs(sourceHeroes[skill]) do if current == name then return end end
        table.insert(sourceHeroes[skill], name)
    end
    heroDefinitions = {}
    for name, definition in pairs(heroes) do
        if type(name) == "string" and name:match("^npc_dota_hero_") and name ~= "npc_dota_hero_base"
            and type(definition) == "table" then
            heroDefinitions[name] = true
            for key, skill in pairs(definition) do
                if type(key) == "string" and key:match("^Ability%d+$") then source(name, skill) end
            end
            -- Modern hero files embed complete definitions here. The root
            -- npc_abilities catalog alone omits most actual hero abilities.
            if type(definition.AbilityDefinitions) == "table" then
                for skill, ability in pairs(definition.AbilityDefinitions) do
                    if abilityName(skill) and type(ability) == "table" then
                        heroAbilities[skill] = ability
                        source(name, skill)
                    end
                end
            end
            if type(definition.Facets) == "table" then
                for _, facet in pairs(definition.Facets) do
                    if type(facet) == "table" and type(facet.Abilities) == "table" then
                        for _, selection in pairs(facet.Abilities) do
                            if type(selection) == "table" and abilityName(selection.AbilityName) then
                                facetSkills[selection.AbilityName] = true
                                source(name, selection.AbilityName)
                            end
                        end
                    end
                end
            end
        end
    end
    directory, ordered = {}, {}
    local function addDefinition(name, definition, isItem)
        if not abilityName(name) or type(definition) ~= "table" or directory[name]
            or name == "ability_base" or name == "dota_base_ability" or name == "item_base" then return end
        local base = tostring(definition.BaseClass or ""):lower()
        if base:find("lua", 1, true) or base:find("datadriven", 1, true) then return end
        local behavior = tostring(definition.AbilityBehavior or "")
        local hidden = hasFlag(behavior, "DOTA_ABILITY_BEHAVIOR_HIDDEN")
        local talent = name:match("^special_bonus_") ~= nil or name == "attribute_bonus"
            or definition.AbilityType == "DOTA_ABILITY_TYPE_ATTRIBUTES"
        local item = isItem or name:match("^item_") ~= nil or hasFlag(behavior, "DOTA_ABILITY_BEHAVIOR_ITEM")
        local generic = name == "generic_hidden" or name == "default_attack"
            or name:match("^generic_") ~= nil or name:match("^ability_") ~= nil
        local innate = checked(definition.Innate) or hasFlag(behavior, "DOTA_ABILITY_BEHAVIOR_INNATE_UI")
        local facet = facetSkills[name] == true
        local category = talent and "talent" or innate and "innate" or item and "item" or generic and "generic" or hidden and "hidden" or "ability"
        local sources = sourceHeroes[name] or {}
        table.sort(sources)
        local associated = {}
        for _, key in ipairs({ "AssociatedPrimaryAbilities", "AssociatedSecondaryAbilities" }) do
            if type(definition[key]) == "string" then
                for dependency in definition[key]:gmatch("[a-z][a-z0-9_]*") do
                    if dependency ~= name then table.insert(associated, dependency) end
                end
            end
        end
        local complex = complexFamily(name) or #associated > 0 or facet
            or hasFlag(behavior, "DOTA_ABILITY_BEHAVIOR_NOT_LEARNABLE")
        local note = complex and "需附属技能或原英雄状态；尚未验证。" or "跨英雄效果尚未验证。"
        if #associated > 0 then note = note .. " KV 关联：" .. table.concat(associated, ", ") .. "。" end
        if #sources == 0 then note = note .. " 未找到来源英雄，资源预载无法确认。" end
        if facet then note = "命石关联技能：添加技能不会切换命石，也不保证相关状态存在。 " .. note end
        if innate then note = "先天技能：可能依赖原英雄或自动等级；跨英雄效果未验证。 " .. note end
        if talent then note = "天赋或属性项：可能绑定原英雄；不保证跨英雄效果。" end
        if item then note = "物品技能：AddAbility 不等于获得物品，原生绑定可能拒绝添加。" end
        if generic or hidden then note = "隐藏或引擎辅助项：可能需要附属技能，不保证图标与效果。" end
        local maximum = integer(definition.MaxLevel, 0, 128)
        local estimated = maximum == nil
        if maximum == nil then maximum = definition.AbilityType == "DOTA_ABILITY_TYPE_ULTIMATE" and 3 or (talent or innate) and 1 or 4 end
        local localizationToken = "#DOTA_Tooltip_ability_" .. name
        local display = tokens[name] or name
        local entry = { name = name, sourceHero = sources[1] or "", sourceHeroes = sources,
            category = category, innate = innate, facetAssociated = facet, complexity = complex and "complex" or "unverified",
            associatedAbilities = associated,
            dependencyNote = note, maxLevel = maximum, maxLevelEstimated = estimated, hidden = hidden,
            requiresRisk = category ~= "ability" or complex or #sources == 0,
            localizationToken = localizationToken, localizedName = display }
        directory[name] = entry
        table.insert(ordered, name)
    end
    -- Hero definitions win over legacy/shared stubs with the same name.
    for name, definition in pairs(heroAbilities) do addDefinition(name, definition, false) end
    for name, definition in pairs(abilities) do addDefinition(name, definition, false) end
    for name, definition in pairs(items) do addDefinition(name, definition, true) end
    table.sort(ordered)
    log("DIRECTORY", "entries=" .. #ordered .. "; source=runtime KV; complex effects unverified")
    return true
end

local function catalog(options)
    local ok, reason = loadDirectory()
    if not ok then return nil, reason end
    options = type(options) == "table" and options or {}
    local query = type(options.query) == "string" and options.query or ""
    if #query > 192 then return nil, "搜索内容过长。" end
    local category = options.category or "default"
    if not categories[category] then return nil, "未知技能分类。" end
    local size = integer(options.pageSize or 5, 1, 24)
    local page = integer(options.page or 1, 1, 10000)
    if not size or not page then return nil, "页码或每页数量无效。" end
    local needle, matches = query:lower(), {}
    for _, name in ipairs(ordered) do
        local entry = directory[name]
        local included = category == "all" or (category == "default" and entry.category == "ability")
            or category == entry.category or (category == "complex" and entry.complexity == "complex")
        if included and (needle == "" or name:find(needle, 1, true)
            or entry.localizedName:lower():find(needle, 1, true)
            or (localizedSearch[name] and localizedSearch[name]:find(needle, 1, true))
            or entry.sourceHero:find(needle, 1, true)) then
            table.insert(matches, entry)
        end
    end
    local pages = math.max(1, math.ceil(#matches / size))
    page = math.min(page, pages)
    local rows = {}
    for index = (page - 1) * size + 1, math.min(page * size, #matches) do table.insert(rows, matches[index]) end
    return { query = query, category = category, page = page, pageSize = size,
        total = #matches, totalPages = pages, items = rows }
end

local function ownedEntry(hero, name)
    local record = ownedByHero[hero] and ownedByHero[hero][name]
    if not record or not valid(record.handle) then return nil end
    local ok, current = call(hero, "FindAbilityByName", name)
    if ok and current == record.handle then return record end
    return nil
end

local function inspect(hero)
    local ok, count = call(hero, "GetAbilityCount")
    count = ok and integer(count, 1, 64) or nil
    if not count then return nil, "无法核实技能槽数量。" end
    local snapshot = { count = count, slots = {}, empty = {} }
    for index = 0, count - 1 do
        local slotOK, handle = call(hero, "GetAbilityByIndex", index)
        if not slotOK then return nil, "无法读取技能槽。" end
        if handle == nil then table.insert(snapshot.empty, index)
        elseif not valid(handle) then return nil, "技能槽中存在失效句柄。"
        else
            local nOK, name = call(handle, "GetAbilityName")
            local lOK, level = call(handle, "GetLevel")
            local iOK, abilityIndex = call(handle, "GetAbilityIndex")
            local hOK, hidden = call(handle, "IsHidden")
            local aOK, active = call(handle, "IsActivated")
            local mOK, maximum = call(handle, "GetMaxLevel")
            if not (nOK and lOK and iOK and hOK and aOK and mOK) then return nil, "无法读取原生技能状态。" end
            snapshot.slots[index] = { handle = handle, name = name, index = abilityIndex,
                level = level, maxLevel = maximum, hidden = hidden, active = active }
        end
    end
    return snapshot
end

local function preserved(hero, snapshot, exempt, added)
    local after, reason = inspect(hero)
    if not after then return false, reason end
    for slot, original in pairs(snapshot.slots) do
        if original.handle ~= exempt then
            local ok, current = call(hero, "GetAbilityByIndex", slot)
            if not ok or current ~= original.handle then return false, "原技能槽位发生变化。" end
            for _, field in ipairs({ { "GetAbilityIndex", "index" }, { "GetLevel", "level" },
                { "IsHidden", "hidden" }, { "IsActivated", "active" } }) do
                local readOK, value = call(current, field[1])
                if not readOK or value ~= original[field[2]] then return false, "其他技能状态发生变化。" end
            end
        end
    end
    -- GetAbilityCount is a dynamic occupied length on modern heroes, not a
    -- promised fixed capacity. Count may grow/shrink, but new raw slots must
    -- contain only the one exact instance we just added. Never adopt dependent
    -- or unrelated skills merely because AddAbility also created them.
    for slot, current in pairs(after.slots) do
        local original = snapshot.slots[slot]
        if (not original or original.handle ~= current.handle) and current.handle ~= added then
            return false, "出现非本工具新增的技能或原始槽位变化。"
        end
    end
    return true
end

local function state(requestId, success, errorMessage)
    -- Populate names/innate metadata before the first hero skill snapshot.
    loadDirectory()
    local result = { requestId = tostring(requestId or "console"), runtimeEpoch = runtimeEpoch, ok = success ~= false,
        error = errorMessage or "", revision = revision, hero = { name = "", unitName = "" }, skills = {} }
    local ctx = context(false)
    result.panel = panelState(ctx)
    if ctx then
        local _, name = call(ctx.hero, "GetUnitName")
        local facetOK, facet = call(ctx.hero, "GetHeroFacetID")
        result.hero = { name = tostring(name or ""), unitName = tostring(name or ""),
            facetID = facetOK and tonumber(facet) or nil, playerID = ctx.playerID, map = ctx.map }
        local snapshot = inspect(ctx.hero)
        if snapshot then
            result.slotCount, result.emptySlots = snapshot.count, #snapshot.empty
            result.appendAvailable = snapshot.count < 64
            for index = 0, snapshot.count - 1 do
                local skill = snapshot.slots[index]
                if skill then
                    local owned = ownedEntry(ctx.hero, skill.name) ~= nil
                    table.insert(result.skills, { name = skill.name, index = skill.index, level = skill.level,
                        maxLevel = skill.maxLevel, hidden = skill.hidden, active = skill.active,
                        owned = owned, readonly = not owned,
                        innate = directory and directory[skill.name] and directory[skill.name].innate or false,
                        localizedName = directory and directory[skill.name] and directory[skill.name].localizedName or skill.name,
                        localizationToken = "#DOTA_Tooltip_ability_" .. skill.name })
                end
            end
        end
    end
    local entries = catalog(view)
    if entries then result.catalog = entries end
    if pending then result.pending = { ability = pending.name, stage = "precache" } end
    return result
end

local function publish(host, requestId, success, reason)
    local result = state(requestId, success, reason)
    if valid(host) and panelHost == host then call(CustomGameEventManager, "Send_ServerToPlayer", host, RESPONSE, result) end
    if bridgeRequests[requestId] then
        bridgeReply(requestId, result)
        if not pending or pending.requestId ~= requestId then bridgeRequests[requestId] = nil end
    end
    log(success and "OK" or "REFUSED", reason or "")
    return result
end

local function doAdd(ctx, entry, requestedLevel)
    local existsOK, existing = call(ctx.hero, "FindAbilityByName", entry.name)
    if not existsOK or existing ~= nil then return false, "已存在同名技能，不能覆盖。" end
    local before, reason = inspect(ctx.hero)
    if not before then return false, reason end
    if #before.empty == 0 and before.count >= 64 then return false, "技能列表已达到本工具的 64 项检查上限；不再尝试追加。" end
    local function provenNewInstance(candidate)
        if not valid(candidate) then return false end
        for _, original in pairs(before.slots) do if candidate == original.handle then return false end end
        local nameOK, candidateName = call(candidate, "GetAbilityName")
        local currentOK, current = call(ctx.hero, "FindAbilityByName", entry.name)
        -- Some engine helper abilities report GetAbilityIndex()==0 despite
        -- occupying another raw slot. Locate the new handle by enumeration;
        -- preserve each original's reported index without treating it as the
        -- raw enumeration index or overwriting it.
        local countOK, count = call(ctx.hero, "GetAbilityCount")
        count = countOK and integer(count, 1, 64) or nil
        if not count or not nameOK or candidateName ~= entry.name or not currentOK or current ~= candidate then return false end
        local found, rawSlot = 0, nil
        for index = 0, count - 1 do
            local slotOK, atSlot = call(ctx.hero, "GetAbilityByIndex", index)
            if not slotOK then return false end
            if atSlot == candidate then
                found, rawSlot = found + 1, index
            end
        end
        return found == 1, rawSlot
    end
    local function vacantNewSlot(candidate)
        local proven, rawSlot = provenNewInstance(candidate)
        return proven and before.slots[rawSlot] == nil
    end
    local ok, ability = call(ctx.hero, "AddAbility", entry.name)
    if not ok or not valid(ability) then
        local foundOK, partial = call(ctx.hero, "FindAbilityByName", entry.name)
        if foundOK and vacantNewSlot(partial) then
            ownedByHero[ctx.hero] = ownedByHero[ctx.hero] or {}
            ownedByHero[ctx.hero][entry.name] = { handle = partial, partial = true, beforeAdd = before }
        end
        return false, "原生引擎拒绝添加；若有残留，只允许清理该新增实例。"
    end
    ownedByHero[ctx.hero] = ownedByHero[ctx.hero] or {}
    local currentOK, current = call(ctx.hero, "FindAbilityByName", entry.name)
    local nameOK, actualName = call(ability, "GetAbilityName")
    if not currentOK or current ~= ability or not nameOK or actualName ~= entry.name or not provenNewInstance(ability) then
        if currentOK and vacantNewSlot(current) then
            ownedByHero[ctx.hero][entry.name] = { handle = current, partial = true, beforeAdd = before }
        end
        return false, "新增实例身份读回失败；不会修改返回的其他技能句柄。"
    end
    if not vacantNewSlot(ability) then
        -- Exact new return-handle ownership is independent of the stricter
        -- old-slot preservation check. Keep only cleanup authority, rather
        -- than orphaning this instance or treating moved native skills as ours.
        ownedByHero[ctx.hero][entry.name] = { handle = ability, partial = true, beforeAdd = before }
        revision = revision + 1
        return false, "新增实例挤占原始槽位；未通过原槽位验证，只允许清理该确切新增实例。"
    end
    ownedByHero[ctx.hero][entry.name] = { handle = ability, partial = false }
    local maxOK, maximum = call(ability, "GetMaxLevel")
    maximum = maxOK and integer(maximum, 0, 128) or nil
    local level = maximum and integer(requestedLevel == nil and (maximum > 0 and 1 or 0) or requestedLevel, 0, maximum)
    local upgraded = level ~= nil and call(ability, "SetLevel", level)
    local readOK, actual = call(ability, "GetLevel")
    local intact, changedReason = preserved(ctx.hero, before, nil, ability)
    local identityOK, identity = call(ctx.hero, "FindAbilityByName", entry.name)
    if not maximum or not upgraded or not readOK or actual ~= level or not intact
        or not identityOK or identity ~= ability or not vacantNewSlot(ability) then
        local identityOK, identity = call(ctx.hero, "FindAbilityByName", entry.name)
        if not identityOK or identity ~= ability then
            ownedByHero[ctx.hero][entry.name] = nil
            return false, (changedReason or "技能等级读回失败。") .. " 当前同名句柄已改变；不删除其他来源的技能。"
        end
        call(ctx.hero, "RemoveAbility", entry.name)
        local checkOK, remaining = call(ctx.hero, "FindAbilityByName", entry.name)
        if checkOK and remaining == nil then ownedByHero[ctx.hero][entry.name] = nil
        else
            ownedByHero[ctx.hero][entry.name].partial = true
            ownedByHero[ctx.hero][entry.name].beforeAdd = before
        end
        return false, (changedReason or "技能等级读回失败。") .. " 新增项清理=" .. tostring(checkOK and remaining == nil)
    end
    revision = revision + 1
    log("ADDED", entry.name .. " level=" .. level .. "; effect remains unverified")
    return true, entry.dependencyNote
end

function M.Add(name, options, requestId, rpcContext)
    local ctx, reason = resolveContext(rpcContext)
    if not ctx then return false, reason end
    if pending then return false, "已有资源预载请求，请稍候。" end
    local loaded, loadReason = loadDirectory()
    if not loaded then return false, loadReason end
    local entry = abilityName(name) and directory[name] or nil
    if not entry then return false, "本机构建没有这个原生技能定义。" end
    options = type(options) == "table" and options or {}
    if entry.requiresRisk and not checked(options.allowRisk) then return false, "此技能需附属或属于高级项，请先确认风险。" end
    if options.level ~= nil and not integer(options.level, 0, 128) then return false, "技能等级必须是有效整数。" end
    if options.level ~= nil and not entry.maxLevelEstimated and tonumber(options.level) > entry.maxLevel then return false, "等级超出本机 KV 定义的范围。" end
    local requestedLevel = options.level
    local existsOK, existing = call(ctx.hero, "FindAbilityByName", name)
    if not existsOK or existing ~= nil then return false, "已存在同名技能，不能覆盖。" end
    local snapshot, inspectReason = inspect(ctx.hero)
    if not snapshot then return false, inspectReason end
    if #snapshot.empty == 0 and snapshot.count >= 64 then return false, "技能列表已达到本工具的 64 项检查上限；不再尝试追加。" end
    local sourceHero = options.sourceHero or entry.sourceHero
    if options.sourceHero then
        local matched = false
        for _, source in ipairs(entry.sourceHeroes) do if source == options.sourceHero then matched = true end end
        if not matched then return false, "来源英雄不属于此技能的本机定义。" end
    end
    if options.precache == false then
        if not checked(options.allowRisk) then return false, "跳过资源预载需确认高级风险。" end
        return doAdd(ctx, entry, requestedLevel)
    end
    if sourceHero == "" or cachedHeroes[sourceHero] then return doAdd(ctx, entry, requestedLevel) end
    if not heroDefinitions[sourceHero] or type(PrecacheUnitByNameAsync) ~= "function" then return false, "无法预载来源英雄资源。" end
    generation = generation + 1
    local record = { name = name, ctx = ctx, token = generation, requestId = requestId or "console" }
    pending = record
    local ok, errorMessage = pcall(PrecacheUnitByNameAsync, sourceHero, function()
        cachedHeroes[sourceHero] = true
        if pending ~= record or record.token ~= generation then return end
        pending = nil
        local current, currentReason = context(false)
        if not current or current.host ~= ctx.host or current.hero ~= ctx.hero or current.map ~= ctx.map then
            record.completed, record.success, record.reason = true, false, currentReason or "预载期间英雄已切换；没有添加技能。"
            publish(ctx.host, record.requestId, false, currentReason or "预载期间英雄已切换；没有添加技能。")
            return
        end
        local added, addReason = doAdd(current, entry, requestedLevel)
        record.completed, record.success, record.reason = true, added, addReason
        publish(ctx.host, record.requestId, added, addReason)
    end)
    if not ok then pending = nil return false, "预载请求失败：" .. tostring(errorMessage) end
    if pending == record then
        local timerOK = contextThink(ctx, "CurrentSkillEditor:PrecacheTimeout", function()
            if pending == record then
                pending = nil generation = generation + 1
                publish(ctx.host, record.requestId, false, "资源预载超时；没有添加技能。")
            end
            return nil
        end, 15)
        if not timerOK then pending = nil generation = generation + 1 return false, "无法安排资源预载超时保护。" end
    end
    if record.completed then return record.success, record.reason end
    return true, "正在预载来源英雄资源。"
end

function M.Level(name, level, rpcContext)
    local ctx, reason = resolveContext(rpcContext)
    if not ctx then return false, reason end
    if pending then return false, "请先等待资源预载。" end
    local record = abilityName(name) and ownedEntry(ctx.hero, name) or nil
    if not record or record.partial then return false, "只可升级本工具成功添加的当前技能实例。" end
    local maxOK, maximum = call(record.handle, "GetMaxLevel")
    maximum = maxOK and integer(maximum, 0, 128) or nil
    local value = maximum and integer(level, 0, maximum)
    if value == nil then return false, "等级超出这个原生技能的范围。" end
    local before, inspectReason = inspect(ctx.hero)
    if not before then return false, inspectReason end
    local ok = call(record.handle, "SetLevel", value)
    local readOK, actual = call(record.handle, "GetLevel")
    local intact, changedReason = preserved(ctx.hero, before, record.handle)
    if not ok or not readOK or actual ~= value or not intact or ownedEntry(ctx.hero, name) ~= record then
        return false, changedReason or "技能等级或实例归属读回失败。"
    end
    revision = revision + 1
    log("LEVEL", name .. " level=" .. value)
    return true, "等级已更新；效果仍需试玩确认。"
end

function M.Remove(name, rpcContext)
    local ctx, reason = resolveContext(rpcContext)
    if not ctx then return false, reason end
    if pending then return false, "请先等待资源预载。" end
    local record = abilityName(name) and ownedEntry(ctx.hero, name) or nil
    if not record then return false, "不能删除原技能或其他来源的技能实例。" end
    local before, inspectReason = inspect(ctx.hero)
    if not before then return false, inspectReason end
    local ok = call(ctx.hero, "RemoveAbility", name)
    local readOK, remaining = call(ctx.hero, "FindAbilityByName", name)
    if not ok or not readOK or remaining ~= nil then return false, "原生删除读回失败。" end
    ownedByHero[ctx.hero][name] = nil
    revision = revision + 1
    local intact, changedReason = preserved(ctx.hero, record.partial and record.beforeAdd or before, record.handle)
    log("REMOVED", name)
    if not intact then return false, changedReason .. " 新增实例已移除，但不会重写其他原技能。" end
    return true, "新增实例已移除；持续效果和召唤物不做笼统清理。"
end

function M.Search(options)
    local ctx, reason = context(true)
    if not ctx then return nil, reason end
    local entries, errorMessage = catalog(options)
    if entries then
        view = { query = entries.query, category = entries.category, page = entries.page, pageSize = entries.pageSize }
        log("CATALOG", "total=" .. entries.total .. " page=" .. entries.page .. " category=" .. entries.category)
        for _, entry in ipairs(entries.items) do
            log("ENTRY", entry.name .. " category=" .. entry.category .. " source=" .. entry.sourceHero
                .. " risk=" .. tostring(entry.requiresRisk) .. " complexity=" .. entry.complexity)
        end
    end
    return entries, errorMessage
end

function M.Status()
    local ctx, reason = context(true)
    if not ctx then return nil, reason end
    local result = state("console", true)
    log("SNAPSHOT", "hero=" .. result.hero.unitName .. " slots=" .. tostring(result.slotCount)
        .. " empty=" .. tostring(result.emptySlots) .. " revision=" .. revision)
    for _, skill in ipairs(result.skills) do
        log("SLOT", "name=" .. skill.name .. " index=" .. skill.index .. " level=" .. skill.level
            .. " hidden=" .. tostring(skill.hidden) .. " active=" .. tostring(skill.active)
            .. " owned=" .. tostring(skill.owned) .. " readonly=" .. tostring(skill.readonly))
    end
    return result
end

function M.ClosePanel(rpcHost, preservePending)
    local host, reason
    if rpcHost then
        host, reason = hostGuard(false, false)
        if host ~= rpcHost then return false, "面板操作来源不是本机玩家。" end
    else host, reason = hostGuard(false, true) end
    if not host then return false, reason end
    if panelHost and panelHost ~= host then return false, "面板不属于当前本机玩家。" end
    if preservePending and pending then return false, "资源预载中，请完成后再切换面板。" end
    local cancelled = pending
    generation = generation + 1
    pending = nil
    if cancelled then publish(cancelled.ctx.host, cancelled.requestId, false, "资源预载请求已取消；没有添加技能。") end
    if panelHost then
        local idOK, playerID = call(host, "GetPlayerID")
        if not idOK then return false, "无法核实面板归属。" end
        local mapOK, map = false, nil
        if type(GetMapName) == "function" then mapOK, map = pcall(GetMapName) end
        local support = mapOK and nativePanelSupport({ map = map }) or nil
        if support and support.supported and panelMap == map then
            local ok = call(CustomUI, "DynamicHud_Destroy", playerID, HUD)
            if not ok then return false, "独立面板关闭请求失败。" end
        end
    end
    panelHost, panelMap, panelReady, panelRequested = nil, nil, false, false
    print("CURRENT_SKILL_EDITOR_PANEL closed")
    return true, "面板已关闭；已添加技能保留在当前试玩中。"
end

function M.OpenPanel(internalBootstrap)
    -- Only lifecycle loading uses false. Console handlers never pass this;
    -- all mutations and their RPC source checks remain host-authenticated.
    local ctx, reason = context(internalBootstrap ~= false)
    if not ctx then return false, reason end
    if pending then return false, "资源预载中，请完成后再切换面板。" end
    local support = nativePanelSupport(ctx)
    if not support.supported then return false, support.reason end
    if panelHost == ctx.host and panelMap == ctx.map then print("CURRENT_SKILL_EDITOR_PANEL already_requested") return true, "面板已请求打开。" end
    if panelHost then return false, "旧面板上下文已改变；请先关闭旧面板。" end
    panelReady = false
    local ok = call(CustomUI, "DynamicHud_Create", ctx.playerID, HUD, LAYOUT, {})
    if not ok then return false, "此构建无法请求动态面板。" end
    panelHost, panelMap, panelRequested = ctx.host, ctx.map, true
    print("CURRENT_SKILL_EDITOR_PANEL requested; client rendering unverified")
    publish(ctx.host, "panel", true)
    return true, "独立面板加载已请求；实际画面待客户端确认。"
end

function M.SetPanel(mode, rpcContext)
    local ctx, reason = resolveContext(rpcContext)
    if not ctx then return false, reason end
    if mode ~= "open" and mode ~= "close" then return false, "面板参数应为 open 或 close。" end
    if pending then return false, "资源预载中，请完成后再切换面板。" end
    if mode == "close" then return M.ClosePanel(ctx.host, true) end
    return M.OpenPanel(false)
end

function M.TogglePanel()
    return M.SetPanel(panelRequested and "close" or "open")
end

function M.RearmPanel()
    local host, reason = hostGuard(false, false)
    if not host then return false, reason end
    if pending then return false, "资源预载中，不重载或切换面板。" end
    local requested = panelRequested
    local closed, closeReason = M.ClosePanel(host, true)
    if not closed then return false, closeReason end
    if not requested then
        print("CURRENT_SKILL_EDITOR_PANEL kept_closed; bridge available")
        return true
    end
    local current = context(false)
    if current and not nativePanelSupport(current).supported then
        print("CURRENT_SKILL_EDITOR_PANEL skipped_non_native; bridge available")
        return true
    end
    return M.OpenPanel(false)
end

function M.BridgeRequest(capability, requestId, action, args)
    if type(requestId) ~= "string" or #requestId < 1 or #requestId > 48
        or not requestId:match("^[a-zA-Z0-9_-]+$") then return false, "invalid bridge request ID" end
    local function refused(reason)
        bridgeReply(requestId, { requestId = requestId, ok = false, error = reason, revision = revision })
        return false, reason
    end
    local session = runtimeKV("scripts/npc/current_skill_session_v1.txt", "CurrentSkillSession")
    local expected = session and session.Capability
    if type(expected) ~= "string" or #expected ~= 64 or not expected:match("^[a-fA-F0-9]+$")
        or type(capability) ~= "string" or #capability ~= 64 or not capability:match("^[a-fA-F0-9]+$") then
        return refused("会话能力凭据无效。")
    end
    expected, capability = expected:lower(), capability:lower()
    local difference = 0
    for index = 1, 64 do
        difference = difference + (expected:byte(index) == capability:byte(index) and 0 or 1)
    end
    if difference ~= 0 then return refused("会话能力凭据不匹配。") end
    local ctx, reason = context(false)
    if not ctx then return refused(reason) end
    local _, _, pawn = hostGuard(true, false)
    -- A valid capability authorizes the manager's anonymous native netcon.
    -- Any explicit remote issuer is still refused, even with the capability.
    local issuerRead = false
    for _, method in ipairs({ "GetDOTACommandClient", "GetCommandClient" }) do
        local methodOK, fn = pcall(function() return Convars[method] end)
        if methodOK and type(fn) == "function" then
            local issuerOK, issuer = call(Convars, method)
            if not issuerOK then return refused("无法核实命令来源。") end
            issuerRead = true
            if issuer ~= nil and issuer ~= ctx.host and issuer ~= pawn then return refused("远端命令来源不能编辑本机英雄。") end
        end
    end
    if not issuerRead then return refused("缺少命令来源接口。") end
    if type(args) ~= "table" and args ~= nil then return refused("桥接参数无效。") end
    args = args or {}
    if bridgeRequests[requestId] then return refused("桥接请求仍在执行，不能复用编号。") end
    local success, errorMessage = true, nil
    if action == "snapshot" then
        -- A bridge snapshot is not an acknowledgement from a rendered HUD.
    elseif action == "catalog" then
        local entries, searchReason = catalog(args)
        success, errorMessage = entries ~= nil, searchReason
        if entries then view = { query = entries.query, category = entries.category, page = entries.page, pageSize = entries.pageSize } end
    elseif action == "add" then
        local count = 0 for _ in pairs(bridgeRequests) do count = count + 1 end
        if count >= 32 then return refused("桥接未完成请求过多。") end
        bridgeRequests[requestId] = { host = ctx.host, hero = ctx.hero, map = ctx.map }
        success, errorMessage = M.Add(args.ability, { level = args.level, allowRisk = args.allowRisk }, requestId, ctx)
    elseif action == "level" then success, errorMessage = M.Level(args.ability, args.level, ctx)
    elseif action == "remove" then success, errorMessage = M.Remove(args.ability, ctx)
    elseif action == "panel" then success, errorMessage = M.SetPanel(args.mode, ctx)
    elseif action == "close" then success, errorMessage = M.ClosePanel(ctx.host)
    else return refused("未知桥接动作。") end
    local result = state(requestId, success, errorMessage)
    bridgeReply(requestId, result)
    if not pending or pending.requestId ~= requestId then bridgeRequests[requestId] = nil end
    return success, result
end

function M.HandleRequest(source, payload)
    local host, _, pawn = hostGuard(false, false)
    if not host or type(EntIndexToHScript) ~= "function" then return false end
    local index = integer(source, 1, 1000000)
    if not index then log("RPC_SOURCE", "invalid source_type=" .. type(source)) return false end
    local sourceOK, sender = pcall(EntIndexToHScript, index)
    if not sourceOK or (sender ~= host and sender ~= pawn) then log("REFUSED", "foreign UI source") return false end
    log("RPC_SOURCE", "source_type=" .. type(source) .. " matches_local_host=true")
    -- Engine event source is authoritative. payload.PlayerID is deliberately ignored.
    if type(payload) ~= "table" then return false end
    local requestId = payload.requestId
    if type(requestId) ~= "string" or #requestId > 64 or requestId:find("[%c]") then return false end
    local action = payload.action
    if action == "close" then
        local ok, reason = M.ClosePanel(host)
        publish(host, requestId, ok, reason)
        return ok
    end
    local ctx, reason = context(false)
    if not ctx or ctx.host ~= host then publish(host, requestId, false, reason or "本机上下文已改变。") return false end
    local ok, errorMessage = true, nil
    if action == "snapshot" then
        -- The authoritative snapshot is constructed below.
        if panelState(ctx).requested and not panelReady then
            panelReady = true
            print("CURRENT_SKILL_EDITOR_UI_READY authenticated native panel snapshot")
        end
    elseif action == "catalog" then
        local entries, searchReason = catalog(payload)
        ok, errorMessage = entries ~= nil, searchReason
        if entries then view = { query = entries.query, category = entries.category, page = entries.page, pageSize = entries.pageSize } end
    elseif action == "add" then ok, errorMessage = M.Add(payload.ability, payload, requestId, ctx)
    elseif action == "level" then ok, errorMessage = M.Level(payload.ability, payload.level, ctx)
    elseif action == "remove" then ok, errorMessage = M.Remove(payload.ability, ctx)
    elseif action == "panel" then ok, errorMessage = M.SetPanel(payload.mode, ctx)
    else ok, errorMessage = false, "未知操作。" end
    publish(host, requestId, ok, errorMessage)
    return ok
end

function M.Register()
    if type(IsServer) ~= "function" or not IsServer() or type(FCVAR_CHEAT) ~= "number" then return false, "服务端注册接口缺失。" end
    local function optional(value) return value ~= "" and value or nil end
    local function consoleCatalog(_, query, category, page, ...)
        log("CATALOG_ARGS", "extra=" .. select("#", ...) .. " query_type=" .. type(query)
            .. " query_bytes=" .. (type(query) == "string" and #query or 0)
            .. " category_type=" .. type(category) .. " category_bytes=" .. (type(category) == "string" and #category or 0))
        query, category, page = optional(query) or "", optional(category), optional(page)
        -- Support a category-first convenience form without changing the GUI
        -- protocol; omitted native console arguments can be empty strings.
        if categories[query] and not categories[category] then query, category = category or "", query end
        local result, reason = M.Search({ query = query, category = category or "default", page = page or 1 })
        if result then publish(hostGuard(true, true), "console", true) else log("REFUSED", reason) end
        return result ~= nil
    end
    local function consoleBridge(_, capability, requestId, action, a, b, c, d, ...)
        -- All variable input is data. Query text is hex to avoid the engine's
        -- UTF8 console tokenizer; this entry never evaluates Lua or JSON.
        if select("#", ...) > 0 then return false, "too many bridge arguments" end
        local args = {}
        if action == "catalog" then
            if type(d) ~= "string" or (#d > 384) or (d ~= "-" and (#d % 2 ~= 0 or not d:match("^[a-fA-F0-9]+$"))) then
                return false, "invalid hex search text"
            end
            args.query = d == "-" and "" or d:gsub("..", function(pair) return string.char(tonumber(pair, 16)) end)
            if args.query:find("[%c]") then return false, "control bytes in search text" end
            args.category, args.page, args.pageSize = a, b, c
        elseif action == "add" then
            if d ~= nil and d ~= "" then return false, "too many add arguments" end
            if c ~= "0" and c ~= "1" then return false, "risk must be 0 or 1" end
            args.ability, args.level, args.allowRisk = a, b ~= "-" and optional(b) or nil, c == "1"
        elseif action == "level" then
            if optional(c) or optional(d) then return false, "too many level arguments" end
            args.ability, args.level = a, b
        elseif action == "remove" then
            if optional(b) or optional(c) or optional(d) then return false, "too many remove arguments" end
            args.ability = a
        elseif action == "panel" then
            if optional(b) or optional(c) or optional(d) then return false, "too many panel arguments" end
            if a ~= "open" and a ~= "close" then return false, "panel mode must be open or close" end
            args.mode = a
        elseif action == "snapshot" or action == "close" then
            if optional(a) or optional(b) or optional(c) or optional(d) then return false, "too many bridge arguments" end
        end
        return M.BridgeRequest(capability, requestId, action, args)
    end
    local commands = {
        { "current_skill_bridge", consoleBridge },
        { "current_skill_panel", function(_, mode) mode = optional(mode) if mode == nil then mode = panelRequested and "close" or "open" end return M.SetPanel(mode) end },
        { "current_skill_status", function() local result, reason = M.Status() if result then publish(hostGuard(true, true), "console", true) else log("REFUSED", reason) end return result ~= nil end },
        { "current_skill_search", consoleCatalog },
        { "current_skill_add", function(_, name, level, risk) local host = hostGuard(true, true) local ok, reason = M.Add(name, { level = optional(level), allowRisk = risk == "risk" }, "console") publish(host, "console", ok, reason) return ok end },
        { "current_skill_level", function(_, name, level) local host = hostGuard(true, true) local ok, reason = M.Level(name, level) publish(host, "console", ok, reason) return ok end },
        { "current_skill_remove", function(_, name) local host = hostGuard(true, true) local ok, reason = M.Remove(name) publish(host, "console", ok, reason) return ok end },
        { "current_skill_catalog", consoleCatalog },
        { "current_skill_snapshot", function() local result, reason = M.Status() if result then publish(hostGuard(true, true), "console", true) else log("REFUSED", reason) end return result ~= nil end },
    }
    for _, command in ipairs(commands) do
        if not registered[command[1]] then
            local action = command[2]
            local callback = function(...)
                local ok, success, reason = pcall(action, ...)
                if not ok then log("ERROR", success) return false end
                if success == false then log("REFUSED", reason or "操作被拒绝。") end
                return success
            end
            local ok, reason = call(Convars, "RegisterCommand", command[1], callback, "Local listen-host skill editor; cheats required.", FCVAR_CHEAT)
            if not ok then return false, reason end
            registered[command[1]] = true
            log("COMMAND_REGISTERED", command[1])
        end
    end
    if listener == nil then
        local ok, id = call(CustomGameEventManager, "RegisterListener", REQUEST, function(source, payload) M.HandleRequest(source, payload) end)
        if not ok or id == nil then return false, "无法注册面板请求监听。" end
        listener = id
    end
    return true
end

M.protocol = { requestEvent = REQUEST, responseEvent = RESPONSE, hud = HUD, layout = LAYOUT,
    bridgeCommand = "current_skill_bridge", bridgeReply = "CURRENT_SKILL_BRIDGE_REPLY" }
_G[KEY] = M
print("CURRENT_SKILL_EDITOR_LOADED v1; local listen host + cheats; complex skill effects unverified")
local registeredOK, registeredReason = M.Register()
if not registeredOK then log("REFUSED", registeredReason)
else
    local current = context(false)
    if nativeDemo(current) then
        local opened, openReason = M.OpenPanel(false)
        if not opened then log("REFUSED", openReason) end
    else
        print("CURRENT_SKILL_EDITOR_PANEL skipped_non_demo; bridge available")
    end
end
return M
