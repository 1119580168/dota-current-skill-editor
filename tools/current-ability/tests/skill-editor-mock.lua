-- Original synthetic engine model. No Valve KV or native game assets are embedded.
-- Run from repository root using Lua 5.1+ or Fengari; syntax is checked separately as Lua 5.1.
local source = "tools/current-ability/current_skill_editor_v1.lua"
local output, assertions = print, 0
local function expect(condition, message)
    assertions = assertions + 1
    if not condition then error("ASSERTION " .. assertions .. ": " .. message, 2) end
end
local function equal(actual, expected, message) expect(actual == expected, message) end
local function fixture(options)
    local env = { server = true, dedicated = false, cheats = true, map = "hero_demo_main",
        playerCount = 1, clone = false, commands = {}, sent = {}, precache = {}, timers = {},
        createdHud = {}, destroyedHud = {}, logs = {}, addCalls = 0, removeCalls = 0 }
    if options and options.map then env.map = options.map end
    env.addonInfo = options and options.addonInfo or nil
    env.capability = string.rep("a", 64) -- Synthetic fixture only.
    local function ability(name, index, maximum)
        local object = { name = name, index = index, maximum = maximum or 4,
            level = 0, hidden = false, active = true, null = false }
        function object:IsNull() return self.null end
        function object:GetAbilityName() return self.name end
        function object:GetAbilityIndex() return self.index end
        function object:GetLevel() return self.level end
        function object:GetMaxLevel() return self.maximum end
        function object:IsHidden() return self.hidden end
        function object:IsActivated() return self.active end
        function object:SetLevel(value)
            if env.levelThrow then error("synthetic level failure") end
            if not env.levelNoop then self.level = value end
            if env.changeOriginalOnLevel then env.original.level = env.original.level + 1 end
            if env.replaceAddedOnLevel and self ~= env.original then
                env.hero.slots[self.index] = env.makeAbility(self.name, self.index, self.maximum)
            end
        end
        return object
    end
    local function hero(name)
        local object = { name = name, slots = {}, owner = 3, null = false }
        function object:IsNull() return self.null end
        function object:IsRealHero() return true end
        function object:IsClone() return env.clone end
        function object:IsTempestDouble() return env.double == true end
        function object:GetHeroFacetID() return env.facet or 2 end
        function object:GetPlayerOwnerID() return self.owner end
        function object:GetPlayerOwner() return self.owner == 3 and env.host or env.remote end
        function object:GetUnitName() return self.name end
        function object:SetContextThink(name, callback, delay)
            if env.timerFail then error("synthetic timer failure") end
            env.timers[name] = { callback = callback, delay = delay, entity = self }
        end
        function object:GetAbilityCount()
            if options and options.dynamicSlots then
                local highest = -1
                for index in pairs(self.slots) do if index > highest then highest = index end end
                return highest + 1
            end
            return options and options.fixedSlots or 30
        end
        function object:GetAbilityByIndex(index) return self.slots[index] end
        function object:FindAbilityByName(name)
            for _, handle in pairs(self.slots) do if handle.name == name then return handle end end
            return nil
        end
        function object:AddAbility(name)
            env.addCalls = env.addCalls + 1
            if env.addMode == "reject" then return nil end
            if env.addMode == "foreign" then return env.original end
            local index
            local count = self:GetAbilityCount()
            for candidate = 0, count - 1 do if self.slots[candidate] == nil then index = candidate break end end
            if index == nil and options and options.dynamicSlots and count < 64 then index = count end
            if not index then return nil end
            if env.insertBeforeUtilities then
                index = 15
                for slot = count - 1, index, -1 do self.slots[slot + 1] = self.slots[slot] end
            end
            local handle = ability(name, index, name == "special_bonus_test" and 1 or 4)
            self.slots[index] = handle
            if env.addExtraDependency then self.slots[index + 1] = ability("test_unowned_dependency", index + 1, 1) end
            if env.changeOriginalSlotOnAdd then self.slots[0], self.slots[2] = nil, env.original end
            if env.changeOriginalOnAdd then env.original.level = env.original.level + 1 end
            if env.addMode == "partial" then return nil end
            if env.addMode == "throwPartial" then error("synthetic add failure after creation") end
            return handle
        end
        function object:RemoveAbility(name)
            env.removeCalls = env.removeCalls + 1
            if env.removeFail then return end
            for index, handle in pairs(self.slots) do
                if handle.name == name then
                    self.slots[index] = nil handle.null = true
                    if env.insertBeforeUtilities and name == "test_bolt" then
                        local count = self:GetAbilityCount()
                        for slot = index, count - 1 do self.slots[slot] = self.slots[slot + 1] end
                        self.slots[count - 1] = nil
                    end
                    return
                end
            end
        end
        return object
    end
    env.makeAbility, env.makeHero = ability, hero
    env.hero = hero("npc_dota_hero_test_local")
    env.original = ability("test_original", 0, 4)
    env.original.level = 2
    env.talent = ability("special_bonus_original", 13, 1)
    env.talent.hidden, env.talent.active = true, false
    env.hero.slots[0], env.hero.slots[13] = env.original, env.talent
    env.host = { IsNull = function() return false end, GetPlayerID = function() return 3 end,
        GetAssignedHero = function() return env.hero end }
    env.remote = { IsNull = function() return false end, GetPlayerID = function() return 9 end }
    env.listenPawn = { IsNull = function() return false end,
        GetController = function() if env.noController then return nil end return env.host end }
    env.issuer = env.host
    local kv = {
        ["scripts/npc/npc_abilities.txt"] = { DOTAAbilities = {
            test_original = { MaxLevel = "4" }, test_bolt = { MaxLevel = "4" },
            test_slow = { MaxLevel = "4", AssociatedSecondaryAbilities = "test_hidden" },
            test_no_source = { MaxLevel = "4" },
            test_hidden = { AbilityBehavior = "DOTA_ABILITY_BEHAVIOR_HIDDEN" },
            special_bonus_test = { MaxLevel = "1" }, attribute_bonus = {}, generic_hidden = {},
            invoker_test_complex = { MaxLevel = "4" },
            test_custom_lua = { BaseClass = "ability_lua" }, ability_base = {},
        } },
        ["scripts/npc/npc_heroes.txt"] = { DOTAHeroes = {
            npc_dota_hero_base = {}, npc_dota_hero_test_local = { Ability1 = "test_original" },
            npc_dota_hero_test_bolt = { Ability1 = "test_bolt", Ability2 = "test_slow",
                Ability3 = "test_hidden", Ability4 = "special_bonus_test", Ability5 = "invoker_test_complex" },
        } },
        ["scripts/npc/items.txt"] = { DOTAAbilities = { item_test = { MaxLevel = "1" } } },
        ["scripts/npc/current_skill_localization_v1.txt"] = { ChronicleSkillLocalization = {
            Tokens = { test_bolt = "测试闪电", test_slow = "测试减速", test_bolt_description = "不应搜索到的描述" },
            SearchTokens = { test_bolt = "Test Bolt 测试闪电", test_slow = "Test Slow 测试减速" },
        } },
        ["scripts/npc/current_skill_session_v1.txt"] = { CurrentSkillSession = { Capability = env.capability } },
    }
    if options and options.modernDefinitions then
        -- Synthetic split schema; no Valve definitions are embedded.
        kv["scripts/npc/npc_abilities.txt"].DOTAAbilities.test_bolt.MaxLevel = "1"
        local modern = kv["scripts/npc/npc_heroes.txt"].DOTAHeroes.npc_dota_hero_test_bolt
        modern.AbilityDefinitions = {
            test_bolt = { MaxLevel = "4" },
            test_modern_innate = { MaxLevel = "1", Innate = "1", AbilityBehavior = "DOTA_ABILITY_BEHAVIOR_PASSIVE | DOTA_ABILITY_BEHAVIOR_INNATE_UI" },
            test_modern_facet = { MaxLevel = "3" },
        }
        modern.Facets = { synthetic_facet = { Abilities = {
            Ability1 = { AbilityName = "test_modern_facet", AbilityIndex = "5", AutoLevelAbility = "false" },
        } } }
    end
    if options and options.escapeName then
        kv["scripts/npc/current_skill_localization_v1.txt"].ChronicleSkillLocalization.Tokens.test_bolt = "测试\\\"闪电\n"
    end
    if options and options.oversizeName then
        kv["scripts/npc/current_skill_localization_v1.txt"].ChronicleSkillLocalization.Tokens.test_bolt = string.rep("x", 5000)
    end
    if options and options.oversizeReply then
        for index = 1, 24 do
            local name = "test_large_" .. index
            kv["scripts/npc/npc_abilities.txt"].DOTAAbilities[name] = { MaxLevel = "4" }
            kv["scripts/npc/current_skill_localization_v1.txt"].ChronicleSkillLocalization.Tokens[name] = string.rep("x", 2500)
        end
    end
    _G.__current_skill_editor_v1 = nil
    _G.DoUniqueString = options and options.uniqueEpoch and function(prefix)
        equal(prefix, "current_skill_epoch", "engine epoch uses fixed non-secret prefix")
        return options.uniqueEpoch
    end or nil
    _G.print = function(value) table.insert(env.logs, tostring(value)) end
    _G.FCVAR_CHEAT = 16384
    _G.IsServer = function() return env.server end
    _G.IsDedicatedServer = function() return env.dedicated end
    _G.GetListenServerHost = function() return env.listenPawn end
    _G.GetMapName = function() return env.map end
    _G.EntIndexToHScript = function(index)
        if index == 42 then return env.host elseif index == 21 then return env.listenPawn
        elseif index == 84 then return env.remote elseif index == 63 then return env.hero end
    end
    _G.PlayerResource = { GetPlayerCount = function() return env.playerCount end, GetPlayer = function(_, id) return id == 3 and env.host or env.remote end }
    _G.Convars = {
        GetBool = function(_, name) equal(name, "sv_cheats", "only expected cvar read") return env.cheats end,
        GetCommandClient = function() return env.issuer end,
        GetDOTACommandClient = function() return env.issuer end,
        RegisterCommand = function(_, name, callback, _, flags)
            equal(flags, FCVAR_CHEAT, "commands require FCVAR_CHEAT")
            expect(env.commands[name] == nil, "commands are registered once")
            env.commands[name] = callback
        end,
    }
    local mode = { IsNull = function() return env.modeNull == true end, SetContextThink = function(_, name, callback, delay)
        if env.timerFail then error("synthetic timer failure") end
        env.timers[name] = { callback = callback, delay = delay }
    end }
    if options and options.modeThinkMissing then mode.SetContextThink = nil end
    _G.GameRules = { herodemo = options and options.nativeDemo == false and false or {}, GetGameModeEntity = function()
        if options and options.noGameMode then return nil end
        return mode
    end }
    if options and options.nativeDemo == false then _G.GameRules.herodemo = nil end
    _G.LoadKeyValues = function(path)
        expect(not path:match("^resource/localization/"), "server Lua never reads native localization files")
        if path == "scripts/npc/current_skill_session_v1.txt" and env.noSession then return nil end
        if path == "addoninfo.txt" then return env.addonInfo end
        return kv[path]
    end
    _G.PrecacheUnitByNameAsync = function(name, callback)
        if env.precacheThrow then error("synthetic precache failure") end
        if env.precacheSync then callback() else table.insert(env.precache, { name = name, callback = callback }) end
    end
    _G.CustomGameEventManager = {
        RegisterListener = function(_, name, callback)
            equal(name, "current_skill_ui_request", "fixed request event")
            expect(env.listener == nil, "listener is registered once")
            env.listener = callback
            return 1
        end,
        Send_ServerToPlayer = function(_, player, name, data)
            equal(player, env.host, "responses only go to host entity")
            equal(name, "current_skill_ui_state", "fixed response event")
            table.insert(env.sent, data)
        end,
    }
    _G.CustomUI = {
        DynamicHud_Create = function(_, playerID, id, layout)
            table.insert(env.createdHud, { playerID = playerID, id = id, layout = layout })
        end,
        DynamicHud_Destroy = function(_, playerID, id)
            table.insert(env.destroyedHud, { playerID = playerID, id = id })
        end,
    }
    env.module = assert(dofile(source))
    function env:finishPrecache() local operation = table.remove(self.precache, 1) expect(operation ~= nil, "precache is pending") operation.callback() end
    function env:originalIntact()
        equal(self.hero.slots[0], self.original, "original slot remains same handle")
        equal(self.original.level, 2, "original level preserved")
        equal(self.talent.hidden, true, "talent hidden preserved")
        equal(self.talent.active, false, "talent activation preserved")
    end
    return env
end

local e = fixture()
local initialEpoch = e.module.runtimeEpoch
expect(type(initialEpoch) == "string" and #initialEpoch <= 96 and initialEpoch:match("^[a-zA-Z0-9_%-]+$"), "fallback epoch is bounded opaque ASCII")
local count = 0 for _ in pairs(e.commands) do count = count + 1 end
equal(count, 9, "nine public commands include authenticated bridge")
expect(e.module.Register(), "repeat registration succeeds")
equal(dofile(source), e.module, "reloading reuses instance with owned-state retention")
equal(e.module.runtimeEpoch, initialEpoch, "reloading the same Lua VM retains runtime epoch")
local entries = assert(e.module.Search({}))
equal(entries.total, 5, "default directory hides advanced categories")
equal(assert(e.module.Search({ query = "测试闪电" })).total, 1, "native localized search")
local chineseName = assert(e.module.Search({ query = "Test Bolt" })).items[1]
equal(chineseName.name, "test_bolt", "English alternate matches Chinese selected display")
equal(chineseName.localizedName, "测试闪电", "selected Chinese name preserved")
equal(assert(e.module.Search({ query = "TEST BOLT" })).total, 1, "English alternate search is case insensitive")
equal(assert(e.module.Search({ query = "不应搜索到的描述" })).total, 0, "only exact defined skill names are indexed")
local englishName = assert(e.module.Search({ query = "测试减速" })).items[1]
equal(englishName.name, "test_slow", "Chinese alternate matches English selected display")
equal(englishName.localizedName, "测试减速", "modern native Chinese display selected")
expect(e.commands.current_skill_catalog("current_skill_catalog", "测试闪电", "", ""), "empty native optional args fall back to default")
equal(e.sent[#e.sent].catalog.total, 1, "Chinese console query uses synthetic local tokens")
expect(e.commands.current_skill_catalog("current_skill_catalog", "default", "测试闪电", ""), "category-first console convenience")
equal(e.sent[#e.sent].catalog.total, 1, "category-first query preserves localized search")
equal(assert(e.module.Search({ category = "hidden" })).total, 1, "hidden category")
equal(assert(e.module.Search({ category = "talent" })).total, 2, "talent category")
equal(assert(e.module.Search({ category = "item" })).total, 1, "item category")
equal(assert(e.module.Search({ category = "generic" })).total, 1, "generic category")
equal(assert(e.module.Search({ category = "complex" })).total, 2, "complex family and KV dependency warnings")
local related = assert(e.module.Search({ query = "test_slow" })).items[1]
equal(related.associatedAbilities[1], "test_hidden", "native KV associations are only reported")
expect(related.requiresRisk, "associated skill requires explicit risk")
equal(assert(e.module.Search({ page = 100, pageSize = 2 })).page, 3, "page clamped")
expect(e.module.Search({ category = "invalid" }) == nil, "unknown category refused")
expect(e.module.Search({ pageSize = 25 }) == nil, "directory payload bounded")
expect(not e.module.Add("test_custom_lua"), "custom Lua definitions excluded")
expect(not e.module.Add("test_hidden"), "advanced entry requires explicit risk")
expect(not e.module.Add("test_no_source"), "missing source requires explicit risk")
expect(not e.module.Add("test_bolt", { sourceHero = "npc_dota_hero_foreign" }), "arbitrary precache source denied")
expect(not e.module.Add("test_bolt", { level = -1 }), "negative level denied")
expect(not e.module.Add("test_bolt", { level = 1.5 }), "fractional level denied")
expect(not e.module.Add("test_bolt", { level = 5 }), "KV explicit upper bound enforced")
local requestOptions = { level = 1 }
expect(e.module.Add("test_bolt", requestOptions, "async-1"), "valid addition starts async precache")
requestOptions.level = 4
equal(e.addCalls, 0, "no mutation before resources")
expect(not e.module.Add("test_slow"), "parallel additions denied")
expect(not e.module.Remove("test_original"), "pending deletion denied")
e:finishPrecache()
local added = e.hero:FindAbilityByName("test_bolt")
expect(added ~= nil, "async addition creates native handle")
equal(added.level, 1, "level copied before async boundary")
equal(e.sent[#e.sent].requestId, "async-1", "async response preserves request id")
expect(e.sent[#e.sent].ok, "completed add response succeeds")
e:originalIntact()
expect(e.module.Level("test_bolt", 0), "owned skill can unlearn to zero")
expect(e.module.Level("test_bolt", 4), "owned skill can use native maximum")
expect(not e.module.Level("test_bolt", 5), "over-maximum denied")
expect(not e.module.Level("test_original", 3), "original skill level denied")
expect(not e.module.Remove("test_original"), "original removal denied")
expect(not e.module.Add("test_bolt"), "existing skill cannot be overwritten")
expect(e.module.Remove("test_bolt"), "owned native instance removed")
equal(e.hero:FindAbilityByName("test_bolt"), nil, "remove readback")
e:originalIntact()
expect(e.module.OpenPanel(), "owned dynamic HUD request")
equal(e.createdHud[1].playerID, 3, "HUD current player id")
equal(e.createdHud[1].id, "current_skill_editor", "unique element only")
equal(e.createdHud[1].layout, "file://{resources}/layout/custom_game/current_ability_editor.xml", "unique native resource URL")
local sentBefore = #e.sent
expect(not e.module.HandleRequest(84, { requestId = "spoof", action = "add", ability = "test_slow", PlayerID = 3 }), "foreign entity cannot spoof payload id")
equal(#e.sent, sentBefore, "foreign request gets no host response")
expect(not e.module.HandleRequest(3, { requestId = "pid", action = "snapshot", PlayerID = 3 }), "player id is not accepted as entity source")
expect(e.module.HandleRequest(42, { requestId = "view", action = "snapshot", PlayerID = 9 }), "authoritative host source ignores supplied PlayerID")
expect(e.module.HandleRequest(21, { requestId = "pawn-view", action = "snapshot", PlayerID = 9 }), "verified raw local pawn is an authoritative UI source")
expect(not e.module.HandleRequest(63, { requestId = "hero-spoof", action = "snapshot" }), "owned hero is not authorized as player RPC source")
equal(e.sent[#e.sent].skills[1].readonly, true, "original is read only in UI")
local function readyMarks()
    local count = 0
    for _, line in ipairs(e.logs) do if line:match("^CURRENT_SKILL_EDITOR_UI_READY ") then count = count + 1 end end
    return count
end
equal(readyMarks(), 1, "first authenticated snapshot acknowledges the shown panel")
expect(e.module.HandleRequest(42, { requestId = "view-again", action = "snapshot" }), "repeated authenticated snapshot")
equal(readyMarks(), 1, "ready marker occurs only once per panel show")
expect(e.module.ClosePanel(), "close after acknowledged UI")
expect(e.module.HandleRequest(42, { requestId = "closed-view", action = "snapshot" }), "closed panel can still read state")
equal(readyMarks(), 1, "snapshot without an open owned panel is not UI readiness")
expect(e.module.OpenPanel(), "reopen owned panel")
expect(e.module.HandleRequest(42, { requestId = "reopen-view", action = "snapshot" }), "new panel's authenticated snapshot")
equal(readyMarks(), 2, "reopen resets one-time UI acknowledgement")
local existingService = e.module
equal(dofile(source), existingService, "reload retains original owned service instance")
equal(e.destroyedHud[#e.destroyedHud].id, "current_skill_editor", "reload only clears its own HUD handshake")
expect(e.module.OpenPanel(), "reload permits a fresh independent panel request")
expect(e.module.HandleRequest(42, { requestId = "after-reuse", action = "snapshot" }), "reuse requires another real authenticated snapshot")
equal(readyMarks(), 3, "reuse requires a fresh authenticated snapshot despite automatic reopen")
e.cheats = false
expect(e.module.HandleRequest(42, { requestId = "close", action = "close" }), "owned HUD can close after cheats are disabled")
equal(e.destroyedHud[1].id, "current_skill_editor", "does not destroy native HUD")
expect(not e.module.Add("test_slow"), "mutation denied after cheats disabled")

for _, field in ipairs({ "server", "dedicated", "map", "clone", "double", "issuer", "nilIssuer", "owner", "noController" }) do
    e = fixture()
    if field == "server" then e.server = false
    elseif field == "dedicated" then e.dedicated = true
    elseif field == "map" then e.map = "<empty>"
    elseif field == "clone" then e.clone = true
    elseif field == "double" then e.double = true
    elseif field == "nilIssuer" then e.issuer = nil
    elseif field == "noController" then e.noController = true
    elseif field == "issuer" then e.issuer = e.remote
    elseif field == "owner" then e.hero.owner = 9 end
    expect(not e.module.Add("test_bolt"), field .. " authorization refused")
    equal(e.addCalls, 0, field .. " refusal has no native mutation")
end
e = fixture()
GameRules.herodemo = false
expect(not e.module.OpenPanel(), "native HUD requires the actual demo marker")
e = fixture()
expect(not e.module.Add("test_bolt", {}, nil, { host = e.host, hero = e.hero, playerID = 3, map = "dota" }), "caller-supplied mismatched map cannot bypass native checks")

e = fixture()
expect(e.module.Add("test_bolt"), "hero-change test queues precache")
local oldHero = e.hero
e.hero = e.makeHero("npc_dota_hero_test_other")
e:finishPrecache()
equal(e.addCalls, 0, "hero switch cancels delayed mutation")
equal(oldHero:FindAbilityByName("test_bolt"), nil, "old hero not mutated")
expect(not e.sent[#e.sent].ok, "hero-change result is failure")
e = fixture()
expect(e.module.Add("test_bolt"), "close test queues precache")
expect(e.module.ClosePanel(), "close cancels pending even if panel not opened")
e:finishPrecache()
equal(e.addCalls, 0, "late callback after close is inert")
e = fixture()
expect(e.module.Add("test_bolt"), "timeout test queues precache")
e.timers["CurrentSkillEditor:PrecacheTimeout"].callback()
e:finishPrecache()
equal(e.addCalls, 0, "late callback after timeout is inert")
e = fixture({ map = "dota", nativeDemo = false, noGameMode = true })
expect(e.module.Add("test_bolt"), "ordinary map without game-mode entity can queue protected precache")
local hostTimer = e.timers["CurrentSkillEditor:PrecacheTimeout"]
expect(hostTimer ~= nil, "fallback installs only a named context think")
equal(hostTimer.entity, e.hero, "fallback timer belongs to the validated current host hero")
equal(hostTimer.delay, 15, "fallback retains bounded precache delay")
e:finishPrecache()
expect(e.hero:FindAbilityByName("test_bolt") ~= nil, "ordinary fallback precache completion can add")
expect(e.module.Remove("test_bolt"), "ordinary fallback precise instance remains removable")
e = fixture({ map = "dota", nativeDemo = false, noGameMode = true })
expect(e.module.Add("test_bolt"), "ordinary fallback timeout queues")
e.timers["CurrentSkillEditor:PrecacheTimeout"].callback()
e:finishPrecache()
equal(e.addCalls, 0, "fallback timeout invalidates delayed native mutation")
e = fixture({ map = "dota", nativeDemo = false, noGameMode = true })
expect(e.module.Add("test_bolt"), "ordinary fallback hero-change test queues")
local scheduledHero = e.hero
e.hero = e.makeHero("npc_dota_hero_test_other")
e:finishPrecache()
equal(e.addCalls, 0, "fallback still rechecks current hero after resource completion")
equal(scheduledHero:FindAbilityByName("test_bolt"), nil, "fallback never changes old host hero")
e = fixture({ modeThinkMissing = true })
expect(e.module.Add("test_bolt"), "missing mode think method uses current hero interface")
equal(e.timers["CurrentSkillEditor:PrecacheTimeout"].entity, e.hero, "missing method fallback is explicit")
e.module.ClosePanel()
e:finishPrecache()
equal(e.addCalls, 0, "close still cancels fallback precache")
e = fixture({ noGameMode = true })
e.hero.SetContextThink = nil
expect(not e.module.Add("test_bolt"), "missing verified timer methods fail closed")
e:finishPrecache()
equal(e.addCalls, 0, "timer registration failure cancels previously launched resource callback")
e = fixture()
e.timerFail = true
expect(not e.module.Add("test_bolt"), "missing timeout protection rejects pending action")
e:finishPrecache()
equal(e.addCalls, 0, "failed timer cancels late callback")

for _, mode in ipairs({ "partial", "throwPartial" }) do
    e = fixture()
    e.precacheSync, e.addMode = true, mode
    expect(not e.module.Add("test_bolt"), "sync partial add is reported failed")
    expect(e.hero:FindAbilityByName("test_bolt") ~= nil, "partial is tracked")
    expect(not e.module.Level("test_bolt", 2), "partial is cleanup only")
    expect(e.module.Remove("test_bolt"), "exact partial instance can be removed")
    e:originalIntact()
end
e = fixture()
e.precacheSync, e.addMode = true, "foreign"
expect(not e.module.Add("test_bolt"), "foreign native return is rejected")
equal(e.original.level, 2, "foreign handle is never levelled")
expect(not e.module.Remove("test_original"), "foreign return creates no ownership")
e = fixture()
e.precacheSync, e.levelNoop, e.removeFail = true, true, true
expect(not e.module.Add("test_bolt"), "failed level readback and cleanup reported")
expect(not e.module.Level("test_bolt", 2), "failed cleanup residue stays removal only")
e.levelNoop, e.removeFail = false, false
expect(e.module.Remove("test_bolt"), "residue can be explicitly cleaned")
e = fixture()
e.precacheSync, e.replaceAddedOnLevel = true, true
expect(not e.module.Add("test_bolt"), "same-name native replacement during SetLevel is rejected")
equal(e.removeCalls, 0, "failed add cleanup does not delete a foreign same-name replacement")
expect(not e.module.Remove("test_bolt"), "foreign replacement did not acquire tool ownership")
e = fixture()
e.precacheSync, e.changeOriginalOnAdd = true, true
expect(not e.module.Add("test_bolt"), "native changes to original state fail verification")
equal(e.hero:FindAbilityByName("test_bolt"), nil, "only new skill is cleaned after preservation failure")
equal(e.original.level, 3, "does not rewrite original state or falsely claim restoration")
e = fixture()
e.precacheSync = true
expect(e.module.Add("test_bolt"), "ownership swap test adds")
local oldAdded = e.hero:FindAbilityByName("test_bolt")
e.hero.slots[oldAdded.index] = e.makeAbility("test_bolt", oldAdded.index, 4)
expect(not e.module.Remove("test_bolt"), "same-name foreign replacement not owned")
expect(not e.module.Level("test_bolt", 2), "replacement cannot be upgraded")
e = fixture({ fixedSlots = 64 })
for index = 0, 63 do if not e.hero.slots[index] then e.hero.slots[index] = e.makeAbility("test_filler_" .. index, index, 1) end end
expect(not e.module.Add("test_bolt"), "tool inspection bound refused before native mutation")
equal(e.addCalls, 0, "full slot mutation count remains zero")
e = fixture({ dynamicSlots = true })
for index = 0, 18 do
    if not e.hero.slots[index] then e.hero.slots[index] = e.makeAbility("test_native_utility_" .. index, 0, 1) end
end
local utilities = {}
for index = 15, 18 do utilities[index] = e.hero.slots[index] end
e.precacheSync, e.insertBeforeUtilities = true, true
expect(not e.module.Add("test_bolt", { level = 2 }), "inserting into an occupied original raw slot still refuses official add success")
local displacedNew = e.hero:FindAbilityByName("test_bolt")
expect(displacedNew ~= nil, "exact new returned instance retains partial cleanup ownership")
equal(displacedNew:GetLevel(), 0, "partial displaced add never upgrades")
expect(not e.module.Level("test_bolt", 2), "partial displacement cannot grant level-edit authority")
for index = 15, 18 do equal(e.hero.slots[index + 1], utilities[index], "editor has not manually rewritten displaced native utilities") end
expect(e.module.Remove("test_bolt"), "exact partial cleanup succeeds only after native removal restores before-add baseline")
equal(e.hero:FindAbilityByName("test_bolt"), nil, "displaced newly added instance is removable without orphaning")
for index = 15, 18 do equal(e.hero.slots[index], utilities[index], "native removal restores original raw utility slot") end
e:originalIntact()
e = fixture({ dynamicSlots = true })
for index = 0, 18 do if not e.hero.slots[index] then e.hero.slots[index] = e.makeAbility("test_native_utility_" .. index, 0, 1) end end
e.precacheSync, e.insertBeforeUtilities = true, true
expect(not e.module.Add("test_bolt"), "partial swap safety fixture refuses original displacement")
local partialSlot = e.hero:FindAbilityByName("test_bolt"):GetAbilityIndex()
e.hero.slots[partialSlot] = e.makeAbility("test_bolt", partialSlot, 4)
expect(not e.module.Remove("test_bolt"), "foreign replacement never inherits partial cleanup authority")
equal(e.removeCalls, 0, "partial cleanup does not delete a replacement handle")
-- Modern GetAbilityCount is a dynamic occupied length, including helper
-- abilities whose reported GetAbilityIndex may differ from the raw slot.
e = fixture({ map = "dota", nativeDemo = false, dynamicSlots = true })
for index = 0, 18 do
    if not e.hero.slots[index] then
        e.hero.slots[index] = e.makeAbility("test_native_helper_" .. index, 0, 1)
    end
end
e.precacheSync, e.issuer = true, nil
local dynamicBefore = e.hero:GetAbilityCount()
equal(dynamicBefore, 19, "dynamic fixture starts with nineteen occupied slots")
local firstOK, firstState = e.module.BridgeRequest(e.capability, "first-dynamic-snapshot", "snapshot")
expect(firstOK, "first dynamic snapshot succeeds")
equal(firstState.runtimeEpoch, e.module.runtimeEpoch, "authenticated snapshot carries immutable runtime epoch")
equal(firstState.catalog.pageSize, 5, "default snapshot catalog contains five rows")
equal(firstState.emptySlots, 0, "existing dynamic list has no hole")
expect(firstState.appendAvailable, "count is an inspection length, not claimed full engine capacity")
expect(e.module.BridgeRequest(e.capability, "dynamic-add", "add", { ability = "test_bolt", level = 1 }), "append attempted below inspection bound")
equal(e.hero:GetAbilityCount(), 20, "single verified native ability appends to dynamic list")
equal(e.hero:GetAbilityByIndex(19):GetAbilityName(), "test_bolt", "added handle occupies the new raw slot")
expect(e.module.BridgeRequest(e.capability, "dynamic-level", "level", { ability = "test_bolt", level = 2 }), "dynamic added handle can be upgraded")
expect(e.module.BridgeRequest(e.capability, "dynamic-remove", "remove", { ability = "test_bolt" }), "dynamic appended handle can be removed")
equal(e.hero:GetAbilityCount(), dynamicBefore, "dynamic length shrinks after removal")
e:originalIntact()
for index = 1, 18 do
    if index ~= 13 then equal(e.hero.slots[index]:GetAbilityIndex(), 0, "native helper reported index stays untouched") end
end
e = fixture({ modernDefinitions = true })
e.hero.slots[1] = e.makeAbility("test_modern_innate", 1, 1)
local first = assert(e.module.Status())
local boltRow, innateRow
for _, item in ipairs(first.catalog.items) do if item.name == "test_bolt" then boltRow = item end end
for _, skill in ipairs(first.skills) do if skill.name == "test_modern_innate" then innateRow = skill end end
expect(boltRow and boltRow.localizedName == "测试闪电", "first snapshot catalog has selected localization")
expect(innateRow and innateRow.innate == true, "first snapshot skill has initialized innate metadata")
e = fixture({ dynamicSlots = true })
for index = 0, 18 do if not e.hero.slots[index] then e.hero.slots[index] = e.makeAbility("test_native_" .. index, index, 1) end end
e.precacheSync, e.addExtraDependency = true, true
expect(not e.module.Add("test_bolt"), "unowned dependent native append cannot be reported as preserved success")
equal(e.hero:FindAbilityByName("test_bolt"), nil, "failed append cleans only exact newly owned skill")
expect(e.hero:FindAbilityByName("test_unowned_dependency") ~= nil, "unowned side effect is not silently removed")
expect(not e.module.Remove("test_unowned_dependency"), "unowned side effect never acquires removal authorization")
e:originalIntact()
e = fixture({ dynamicSlots = true })
for index = 0, 18 do if not e.hero.slots[index] then e.hero.slots[index] = e.makeAbility("test_native_" .. index, index, 1) end end
e.precacheSync, e.changeOriginalSlotOnAdd = true, true
expect(not e.module.Add("test_bolt"), "raw original slot movement refuses append success")
equal(e.hero:FindAbilityByName("test_bolt"), nil, "failed original raw-slot verification only clears added instance")
equal(e.hero.slots[2], e.original, "editor does not rewrite native changed slots")
e = fixture()
expect(e.module.Add("test_no_source", { allowRisk = "1", level = 1 }), "advanced confirmation permits source-unknown attempt")
equal(#e.precache, 0, "source-unknown entry does not claim precaching")
expect(e.module.Remove("test_no_source"), "source-unknown exact instance still removable")
e = fixture()
expect(e.commands.current_skill_add("current_skill_add", "test_bolt", "1"), "registered console add uses the same service")
e:finishPrecache()
expect(e.commands.current_skill_level("current_skill_level", "test_bolt", "2"), "registered console level uses the same service")
equal(e.hero:FindAbilityByName("test_bolt").level, 2, "command level readback")
expect(e.commands.current_skill_remove("current_skill_remove", "test_bolt"), "registered console remove uses the same service")
e = fixture()
expect(e.module.HandleRequest(42, { requestId = "rpc-add", action = "add", ability = "test_bolt", level = 1 }), "authenticated RPC queues service add")
expect(e.sent[#e.sent].pending ~= nil, "RPC acknowledgement reports pending")
e:finishPrecache()
equal(e.sent[#e.sent].requestId, "rpc-add", "RPC completion preserves id")
expect(e.sent[#e.sent].pending == nil and e.sent[#e.sent].ok, "RPC completion no longer pending")
expect(e.module.HandleRequest(42, { requestId = "rpc-level", action = "level", ability = "test_bolt", level = 2 }), "authenticated RPC changes owned level")
expect(e.module.HandleRequest(42, { requestId = "rpc-remove", action = "remove", ability = "test_bolt" }), "authenticated RPC removes owned skill")
expect(not e.module.HandleRequest(42, { requestId = "rpc-code", action = "execute", code = "arbitrary" }), "RPC has no arbitrary-code action")

-- Modern local matches and arbitrary server-Lua maps are permitted only
-- for the authoritative local host; human count/bots do not grant privileges.
for _, map in ipairs({ "dota", "hero_demo_main", "addon_test_map" }) do
    e = fixture({ map = map, nativeDemo = false })
    e.map, e.playerCount = map, 5
    GameRules.herodemo = nil
    equal(#e.createdHud, 0, "ordinary/server-Lua-only maps never create DynamicHud on module load")
    expect(not e.module.OpenPanel(false), "ordinary map cannot request unsafe native HUD")
    equal(#e.createdHud, 0, "ordinary explicit bootstrap does not create HUD")
    expect(e.module.Add("test_bolt"), "multiple humans/local map permitted: " .. map)
    e:finishPrecache()
    expect(e.module.Remove("test_bolt"), "local host owns only its added skill: " .. map)
    expect(not e.module.HandleRequest(84, { requestId = "foreign", action = "add", ability = "test_bolt", PlayerID = 3 }), "remote human denied in ordinary map")
end
-- Anonymous server console cannot mutate even when auto bootstrap opens HUD.
-- A map called dota and even a valid mode entity are not sufficient native
-- HUD evidence. Only the engine's currently mounted playable addon metadata
-- with an exact map token enables the explicit addon panel route.
for _, info in ipairs({
    { IsPlayable = 1, maps = "dota_old" },
    { IsPlayable = 1, maps = "prefix_dota_suffix" },
    { IsPlayable = 1, maps = "dota/unsafe" },
    { IsPlayable = 0, maps = "dota" },
    { IsPlayable = true, maps = "dota" },
    { IsPlayable = 1, maps = {} },
    { maps = "dota" },
    { IsPlayable = 1 },
}) do
    e = fixture({ map = "dota", nativeDemo = false, addonInfo = info })
    local result = assert(e.module.Status())
    expect(not result.panel.supported and result.panel.kind == "desktop", "malformed/nonmatching engine addon metadata does not enable native HUD")
    expect(not e.module.SetPanel("open"), "unverified addon panel is refused")
    equal(#e.createdHud, 0, "metadata refusal never creates a HUD")
    expect(e.module.SetPanel("close"), "desktop close is harmless")
    equal(#e.destroyedHud, 0, "metadata refusal never destroys ordinary native HUD")
end
e = fixture({ map = "dota", nativeDemo = false })
local desktopState = assert(e.module.Status())
expect(not desktopState.panel.supported and desktopState.panel.kind == "desktop", "valid mode without addoninfo remains desktop")
expect(not desktopState.panel.requested and not desktopState.panel.ready and type(desktopState.panel.reason) == "string", "desktop state describes refusal without invented rendering")
for _, options in ipairs({
    { map = "dota", nativeDemo = false, noGameMode = true, addonInfo = { IsPlayable = 1, maps = "dota" } },
    { map = "unlisted_map", nativeDemo = false, addonInfo = { IsPlayable = 1, maps = "dota" } },
}) do
    e = fixture(options)
    expect(not e.module.SetPanel("open"), "matching metadata still requires valid mode and actual map")
    equal(#e.createdHud, 0, "invalid mode/map never invokes DynamicHud_Create")
end
e = fixture({ map = "dota", nativeDemo = false, addonInfo = { IsPlayable = 1, maps = "dota" } })
e.modeNull = true
expect(not e.module.SetPanel("open"), "null mode handle rejects native addon HUD")
equal(#e.createdHud, 0, "null mode rejection has no HUD call")
e = fixture({ map = "dota", nativeDemo = false, addonInfo = { IsPlayable = 1, maps = "dota" } })
CustomUI.DynamicHud_Create = nil
expect(not e.module.SetPanel("open"), "addon metadata cannot compensate for absent DynamicHud_Create")
equal(assert(e.module.Status()).panel.kind, "desktop", "missing native interface keeps desktop route")
for _, info in ipairs({
    { IsPlayable = 1, maps = "dota" },
    { AddonInfo = { IsPlayable = "1", maps = "other_map dota third_map" } },
}) do
    e = fixture({ map = "dota", nativeDemo = false, addonInfo = info })
    equal(#e.createdHud, 0, "playable addon never opens native HUD automatically")
    local initial = assert(e.module.Status()).panel
    expect(initial.supported and initial.kind == "addon" and not initial.requested and not initial.ready, "flat/wrapped engine addon metadata reports optional native support")
    e.issuer = nil
    expect(not e.module.SetPanel("open"), "anonymous direct addon panel command is not authorized")
    expect(not e.module.BridgeRequest(string.rep("b", 64), "panel-wrong-cap", "panel", { mode = "open" }), "native addon panel needs valid manager capability")
    expect(e.module.BridgeRequest(e.capability, "panel-open", "panel", { mode = "open", PlayerID = 9 }), "authenticated bridge explicitly opens playable addon HUD")
    equal(#e.createdHud, 1, "explicit addon request creates only its own HUD")
    equal(e.createdHud[1].playerID, 3, "payload ID cannot redirect addon HUD")
    expect(e.module.HandleRequest(42, { requestId = "addon-state", action = "snapshot" }), "authoritative player snapshot confirms addon native panel")
    local ready = e.sent[#e.sent].panel
    expect(ready.supported and ready.requested and ready.ready and ready.kind == "addon", "only actual native source handshake marks addon UI ready")
    equal(readyMarks(), 1, "addon readiness has the same one-time native marker")
    expect(e.module.BridgeRequest(e.capability, "panel-close", "panel", { mode = "close" }), "authenticated bridge closes owned addon HUD")
    equal(#e.destroyedHud, 1, "addon close destroys only own element")
    equal(e.destroyedHud[1].id, "current_skill_editor", "addon close cannot destroy map's own HUD")
    local closedOK, closedState = e.module.BridgeRequest(e.capability, "panel-closed-state", "snapshot")
    expect(closedOK, "closed addon remains available over desktop bridge")
    expect(closedState.panel.supported and not closedState.panel.requested and not closedState.panel.ready, "close response retains support while reporting no live native panel")
    equal(dofile(source), e.module, "closed addon source reload retains service ownership")
    equal(#e.createdHud, 1, "reload respects user's explicit addon close")
    expect(e.commands.current_skill_bridge("current_skill_bridge", e.capability, "cmd-panel-open", "panel", "open"), "fixed bridge grammar accepts panel open")
    expect(not e.commands.current_skill_bridge("current_skill_bridge", e.capability, "cmd-panel-invalid", "panel", "toggle"), "bridge panel grammar accepts only open/close")
    expect(not e.commands.current_skill_bridge("current_skill_bridge", e.capability, "cmd-panel-extra", "panel", "close", "extra"), "bridge panel grammar rejects extra args")
    expect(not e.module.BridgeRequest(e.capability, "object-panel-mode", "panel", { mode = {} }), "panel mode cannot contain executable or structured data")
    local hudCount = #e.createdHud
    equal(dofile(source), e.module, "open addon reload retains exact service instance")
    equal(#e.createdHud, hudCount + 1, "only already-requested addon HUD is rearmed after reload")
    equal(readyMarks(), 1, "rearm request alone cannot manufacture UI readiness")
    expect(e.module.HandleRequest(21, { requestId = "addon-rearmed", action = "snapshot" }), "raw verified host pawn can acknowledge rearmed addon HUD")
    equal(readyMarks(), 2, "rearmed addon requires a new native snapshot")
    e.issuer = e.remote
    expect(not e.module.BridgeRequest(e.capability, "remote-panel", "panel", { mode = "close", PlayerID = 3 }), "remote issuer cannot use capability to operate host addon panel")
    expect(not e.module.HandleRequest(84, { requestId = "remote-ui-panel", action = "panel", mode = "close", PlayerID = 3 }), "remote UI cannot redirect a panel close")
end
e = fixture({ map = "dota", nativeDemo = false, addonInfo = { IsPlayable = 1, maps = "dota" } })
e.issuer = nil
expect(e.module.BridgeRequest(e.capability, "desktop-pending", "add", { ability = "test_bolt", level = 1 }), "desktop add can preload while addon native panel is closed")
expect(not e.module.BridgeRequest(e.capability, "pending-open", "panel", { mode = "open" }), "resource preload refuses native panel open")
expect(not e.module.BridgeRequest(e.capability, "pending-close", "panel", { mode = "close" }), "resource preload refuses native panel close without cancellation")
expect(not e.module.RearmPanel(), "reload during pending cannot cancel desktop add")
expect(not e.module.HandleRequest(42, { requestId = "pending-ui-close", action = "panel", mode = "close" }), "authenticated native close also refuses while desktop add is pending")
equal(#e.createdHud, 0, "pending panel attempts never create HUD")
equal(#e.destroyedHud, 0, "pending panel attempts never destroy HUD")
e:finishPrecache()
expect(e.hero:FindAbilityByName("test_bolt") ~= nil, "panel refusal preserves the original desktop add intent")
expect(e.module.BridgeRequest(e.capability, "after-pending-open", "panel", { mode = "open" }), "native panel becomes available after pending completes")
expect(e.module.BridgeRequest(e.capability, "after-pending-close", "panel", { mode = "close" }), "switching back to desktop retains added skills")
expect(e.hero:FindAbilityByName("test_bolt") ~= nil, "closing new panel never removes owned skills")
e:originalIntact()
e = fixture({ map = "dota", nativeDemo = false, addonInfo = { IsPlayable = 1, maps = "dota" } })
expect(e.module.SetPanel("open"), "context change fixture opens verified addon panel")
e.addonInfo = nil
expect(e.module.SetPanel("close"), "lost addon context drops only internal panel intent")
equal(#e.destroyedHud, 0, "ordinary context after addon unmount still never calls DynamicHud_Destroy")
e = fixture({ map = "dota", nativeDemo = false })
e.issuer = nil
expect(not e.module.BridgeRequest(e.capability, "forged-addon-info", "panel", { mode = "open", PlayerID = 3, map = "hero_demo_main", addonInfo = { IsPlayable = 1, maps = "dota" } }), "client addon metadata and map cannot grant native panel support")
equal(#e.createdHud, 0, "forged metadata never invokes a native HUD")
e = fixture()
local demoState = assert(e.module.Status()).panel
expect(demoState.supported and demoState.kind == "demo" and demoState.requested and not demoState.ready, "official demo retains automatic native panel request")
expect(e.module.SetPanel("close"), "official demo can opt back to desktop")
local demoCreated = #e.createdHud
equal(dofile(source), e.module, "official demo closed reload preserves service")
equal(#e.createdHud, demoCreated, "official demo reload respects explicit close")
e = fixture()
e.issuer = nil
expect(not e.module.Add("test_bolt"), "nil console issuer denied")
expect(not e.module.Level("test_original", 1), "nil issuer denied for level")
expect(not e.module.OpenPanel(), "anonymous console panel denied")
expect(e.module.OpenPanel(false), "internal lifecycle open targets listen host")
e.issuer = e.host
expect(e.commands.current_skill_panel("current_skill_panel", ""), "native empty-string panel arg toggles")
expect(e.commands.current_skill_panel("current_skill_panel", ""), "second empty-string panel arg reopens")
expect(e.module.HandleRequest(42, { requestId = "real-ui", action = "snapshot" }), "real local GUI remains authenticated")
-- Source identity must survive asynchronous precaching.
e = fixture()
expect(e.module.Add("test_bolt"), "host-change async starts")
local previousHost = e.host
e.host = e.remote
e:finishPrecache()
equal(e.addCalls, 0, "host change cancels native add")
e.host = previousHost
-- Hero definitions override shared stubs and introduce modern innate/facet entries.
e = fixture({ modernDefinitions = true })
local modernBolt = assert(e.module.Search({ query = "test_bolt" })).items[1]
equal(modernBolt.maxLevel, 4, "modern hero AbilityDefinitions override shared legacy stub")
equal(#modernBolt.sourceHeroes, 1, "slot and embedded definition do not duplicate precache source")
expect(e.module.Add("test_bolt", { level = 4 }), "modern embedded definition permits real maximum")
e:finishPrecache()
equal(e.hero:FindAbilityByName("test_bolt").level, 4, "modern definition level readback")
expect(e.module.Remove("test_bolt"), "modern exact owned skill removed")
local innate = assert(e.module.Search({ category = "innate" }))
equal(innate.total, 1, "modern innate has explicit advanced category")
expect(innate.items[1].innate and innate.items[1].requiresRisk, "innate is marked unverified and requires explicit risk")
expect(not e.module.Add("test_modern_innate"), "innate cannot be silently added")
expect(e.module.Add("test_modern_innate", { allowRisk = true, level = 1 }), "explicit advanced attempt can add defined innate")
expect(e.module.Remove("test_modern_innate"), "only own added innate can be removed")
local facet = assert(e.module.Search({ query = "test_modern_facet" })).items[1]
expect(facet.facetAssociated and facet.requiresRisk, "facet-specific ability retains risk metadata")
equal(facet.sourceHero, "npc_dota_hero_test_bolt", "facet-associated source is native hero")
expect(not e.module.Add("test_modern_facet"), "facet attempt requires confirmation")
equal(e.module.Status().hero.facetID, 2, "current hero facet readback is descriptive only")

-- Authenticated native bridge permits the manager's nil issuer only with
-- a capability from the fixed runtime lease. It never accepts payload IDs.
e = fixture({ map = "dota", nativeDemo = false })
e.issuer = nil
expect(not e.module.Add("test_bolt"), "anonymous normal console remains refused")
local bridgeOK, bridgeState = e.module.BridgeRequest(e.capability, "bridge-snapshot", "snapshot", { PlayerID = 9 })
expect(bridgeOK, "valid capability enables manager snapshot")
equal(bridgeState.hero.playerID, 3, "bridge ignores forged payload PlayerID")
equal(#e.createdHud, 0, "bridge snapshot never creates ordinary native HUD")
equal(#e.sent, 0, "ordinary bridge does not publish to unmounted Panorama")
expect(e.module.BridgeRequest(e.capability, "bridge-add", "add", { ability = "test_bolt", level = 1, PlayerID = 9 }), "valid nonce starts same-service add")
equal(e.addCalls, 0, "bridge add waits for resources")
local function replies(id)
    local result = {}
    for _, line in ipairs(e.logs) do
        if line:find("CURRENT_SKILL_BRIDGE_REPLY " .. id .. " ", 1, true) == 1 then table.insert(result, line) end
    end
    return result
end
equal(#replies("bridge-add"), 1, "async bridge returns pending acknowledgement")
expect(replies("bridge-add")[1]:find('"pending":', 1, true) ~= nil, "bridge acknowledgement contains pending state")
expect(not e.module.BridgeRequest(e.capability, "bridge-add", "add", { ability = "test_slow" }), "in-flight request IDs cannot be reused")
e:finishPrecache()
expect(e.hero:FindAbilityByName("test_bolt") ~= nil, "bridge add applies to actual listen-host hero")
expect(#replies("bridge-add") >= 2, "async final response keeps same bridge request ID")
expect(replies("bridge-add")[#replies("bridge-add")]:find('"ok":true', 1, true) ~= nil, "async final bridge response succeeds")
expect(replies("bridge-add")[#replies("bridge-add")]:find('"pending":', 1, true) == nil, "final bridge response is not pending")
for _, response in ipairs(replies("bridge-add")) do
    expect(response:find('"runtimeEpoch":"' .. e.module.runtimeEpoch .. '"', 1, true) ~= nil, "pending and final bridge replies retain the same epoch")
end
expect(e.module.BridgeRequest(e.capability, "bridge-level", "level", { ability = "test_bolt", level = 2 }), "bridge levels exact own instance")
equal(e.hero:FindAbilityByName("test_bolt").level, 2, "bridge native level readback")
expect(e.module.BridgeRequest(e.capability, "bridge-remove", "remove", { ability = "test_bolt" }), "bridge removes exact own instance")
equal(e.hero:FindAbilityByName("test_bolt"), nil, "bridge removal readback")
e:originalIntact()
expect(not e.module.BridgeRequest(nil, "missing-cap", "snapshot"), "nil capability refused")
expect(replies("missing-cap")[1]:find('"runtimeEpoch":"' .. e.module.runtimeEpoch .. '"', 1, true) ~= nil, "plain bridge refusal also carries runtime epoch")
expect(not e.module.BridgeRequest(string.rep("b", 64), "wrong-cap", "snapshot"), "wrong capability refused")
expect(not e.module.BridgeRequest(string.rep("x", 64), "malformed-cap", "snapshot"), "nonhex capability refused")
expect(not e.module.BridgeRequest(e.capability, "id\nforged", "snapshot"), "control bytes cannot forge reply markers")
expect(not e.module.BridgeRequest(e.capability, "bad-action", "execute", { code = "arbitrary" }), "bridge has no code execution action")
e.issuer = e.remote
expect(not e.module.BridgeRequest(e.capability, "remote-cap", "add", { ability = "test_bolt", PlayerID = 3 }), "explicit foreign console issuer refused even with correct capability")
e.issuer, e.cheats = nil, false
expect(not e.module.BridgeRequest(e.capability, "cheats-off", "snapshot"), "bridge still requires cheats")
e.cheats, e.noSession = true, true
expect(not e.module.BridgeRequest(e.capability, "no-file", "snapshot"), "bridge requires fixed runtime session file")
e.noSession = false
for _, line in ipairs(e.logs) do expect(line:find(e.capability, 1, true) == nil, "capability never appears in reply or logs") end
expect(e.commands.current_skill_bridge("current_skill_bridge", e.capability, "cmd-catalog", "catalog", "default", "1", "5", "e6b58be8af95e997aae794b5"), "hex Unicode catalog command is parsed as data")
expect(not e.commands.current_skill_bridge("current_skill_bridge", e.capability, "bad-hex", "catalog", "default", "1", "5", "00"), "hex control byte query rejected")
expect(e.commands.current_skill_bridge("current_skill_bridge", e.capability, "cmd-snapshot", "snapshot"), "fixed manager command snapshot")
e = fixture({ map = "dota", nativeDemo = false })
e.issuer = nil
expect(e.module.BridgeRequest(e.capability, "cancel-add", "add", { ability = "test_slow", allowRisk = true }), "bridge pending cancellation starts")
expect(e.module.BridgeRequest(e.capability, "cancel-close", "close"), "bridge close cancels only own pending intent")
e:finishPrecache()
equal(e.hero:FindAbilityByName("test_slow"), nil, "late callback after bridge cancellation is inert")
expect(replies("cancel-add")[#replies("cancel-add")]:find('"ok":false', 1, true) ~= nil, "cancelled async add gets final same-ID failure")
equal(#e.createdHud, 0, "entire ordinary bridge sequence never creates native HUD")
equal(#e.destroyedHud, 0, "ordinary bridge close does not invoke DynamicHud destroy")
e = fixture({ map = "dota", nativeDemo = false, escapeName = true })
e.issuer = nil
expect(e.module.BridgeRequest(e.capability, "wire-json", "snapshot"), "JSON encoder accepts native Unicode names")
local encoded = replies("wire-json")[1]
expect(encoded:find("\\u000a", 1, true) ~= nil, "JSON encoder escapes control bytes")
expect(encoded:find("\\\\", 1, true) ~= nil, "JSON encoder escapes literal backslash")
expect(encoded:find('\\"', 1, true) ~= nil, "JSON encoder escapes literal quote")
expect(encoded:find("\n", 1, true) == nil, "bridge reply remains a single physical line")
e = fixture({ map = "dota", nativeDemo = false })
e.issuer = nil
expect(not e.module.BridgeRequest(e.capability, string.rep("r", 49), "snapshot"), "bridge request ID upper bound enforced")
expect(not e.module.BridgeRequest(e.capability, "", "snapshot"), "bridge request ID cannot be empty")
Convars.GetCommandClient = function() return e.remote end
expect(not e.module.BridgeRequest(e.capability, "generic-foreign", "snapshot"), "generic issuer cannot be foreign when DOTA issuer is nil")
Convars.GetCommandClient = function() return e.host end
Convars.GetDOTACommandClient = function() return e.remote end
expect(not e.module.BridgeRequest(e.capability, "dota-foreign", "snapshot"), "DOTA issuer cannot be foreign when generic issuer is local")
e = fixture()
e.issuer = nil
expect(e.module.BridgeRequest(e.capability, "demo-bridge", "snapshot"), "valid bridge can inspect demo")
equal(readyMarks(), 0, "bridge snapshot cannot manufacture native UI_READY")
e = fixture({ map = "dota", nativeDemo = false, oversizeName = true })
e.issuer = nil
e.module.BridgeRequest(e.capability, "size-bound", "snapshot")
local fallback = replies("size-bound")[1]
expect(#fallback < 60000, "oversize native data produces bounded error reply")
expect(fallback:find('"ok":false', 1, true) ~= nil, "encoder bound failure is visible in transport result")
expect(fallback:find("bridge reply encoding failed", 1, true) ~= nil, "encoder fallback is explicit")
expect(fallback:find('"runtimeEpoch":"' .. e.module.runtimeEpoch .. '"', 1, true) ~= nil, "bounded JSON fallback retains runtime epoch")
e = fixture({ map = "dota", nativeDemo = false })
e.issuer, e.facet = nil, math.huge
e.module.BridgeRequest(e.capability, "finite-bound", "snapshot")
expect(replies("finite-bound")[1]:find('"ok":false', 1, true) ~= nil, "nonfinite native values never emit invalid JSON")
e = fixture({ map = "dota", nativeDemo = false, oversizeReply = true })
e.issuer = nil
e.module.BridgeRequest(e.capability, "reply-bound", "catalog", { query = "test_large_", pageSize = 24 })
expect(#replies("reply-bound")[1] < 60000, "aggregate reply size is bounded")
expect(replies("reply-bound")[1]:find('"ok":false', 1, true) ~= nil, "aggregate size failure has an explicit error reply")
expect(not e.module.BridgeRequest(e.capability, "bad-level", "add", { ability = "test_bolt", level = {} }), "structured level input is rejected without Lua error")
e = fixture({ uniqueEpoch = "current_skill_epoch_native_1" })
equal(e.module.runtimeEpoch, "current_skill_epoch_native_1", "native DoUniqueString is preferred")
local epochA = e.module.runtimeEpoch
equal(assert(e.module.Status()).runtimeEpoch, epochA, "console status carries runtime epoch")
equal(dofile(source).runtimeEpoch, epochA, "native epoch is preserved through reload")
e = fixture({ uniqueEpoch = "current_skill_epoch_native_2" })
expect(e.module.runtimeEpoch ~= epochA, "new native VM identity distinguishes a reset revision")
local epochB = fixture().module.runtimeEpoch
local epochC = fixture().module.runtimeEpoch
expect(epochB ~= epochC, "fallback fixture loads also get distinct state identities")
e = fixture({ uniqueEpoch = "invalid epoch\nmarker" })
expect(e.module.runtimeEpoch:match("^[a-zA-Z0-9_%-]+$") and #e.module.runtimeEpoch <= 96, "untrusted malformed engine epoch uses bounded fallback")
_G.print = output
output("CURRENT_SKILL_EDITOR_MOCK_PASS assertions=" .. assertions)
