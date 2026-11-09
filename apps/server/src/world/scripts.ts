/**
 * Résolution ATOMIQUE d'une attaque dans Redis (règle d'architecture n°6).
 *
 * Redis exécute un script Lua sans interruption : deux attaques simultanées sur la même ville sont
 * donc sérialisées, chacune voyant le résultat de la précédente (aucune mise à jour perdue, une seule
 * capture possible par bouclier). Le script est aussi IDEMPOTENT : la clé `applied` mémorise le
 * résultat par identifiant d'attaque, rejouer la même attaque renvoie le résultat d'origine.
 *
 * ⚠ Ce script doit rester strictement équivalent à `resolveAttack` (packages/shared/src/capture.ts).
 * Le test différentiel `world.integration.test.ts` compare les deux sur des scénarios aléatoires.
 *
 * KEYS: 1 hash ville (t, s, i:<faction>) · 2 hash owners · 3 hash versions · 4 clé d'idempotence
 *       5 set « sales » (à persister) · 6 compteur de séquence global
 * ARGV: cityId, attacker, gain, garrison, now(ms), decayPerHour, shieldMs, maxDefenseFactor, ttl(s)
 */
export const APPLY_ATTACK_LUA = `
local cached = redis.call('GET', KEYS[4])
if cached then
  local obj = cjson.decode(cached)
  obj.replay = true
  return cjson.encode(obj)
end

local cityId = ARGV[1]
local attacker = tonumber(ARGV[2])
local gain = tonumber(ARGV[3])
local garrison = tonumber(ARGV[4])
local now = tonumber(ARGV[5])
local decay = tonumber(ARGV[6])
local shieldMs = tonumber(ARGV[7])
local maxFactor = tonumber(ARGV[8])
local ttl = tonumber(ARGV[9])

local o = redis.call('HGET', KEYS[2], cityId)
local owner = 0
if o then owner = tonumber(o) end

local last, shield = now, 0
local inf = {}
local raw = redis.call('HGETALL', KEYS[1])
for i = 1, #raw, 2 do
  local k, v = raw[i], tonumber(raw[i + 1])
  if k == 't' then last = v
  elseif k == 's' then shield = v
  elseif string.sub(k, 1, 2) == 'i:' then inf[tonumber(string.sub(k, 3))] = v end
end

-- 1. érosion
local dt = now - last
if dt < 0 then dt = 0 end
local loss = math.floor(dt * decay / 3600000)
local eroded = {}
for f, v in pairs(inf) do
  local nv = v - loss
  if nv > 0 then eroded[f] = nv end
end
inf = eroded

local prev = owner
local ownerInf = garrison
if owner ~= 0 then
  local c = inf[owner] or 0
  if c > garrison then ownerInf = c end
end
local captured, defended, shielded = false, false, false

-- 2. attaque ou défense
if attacker == owner then
  defended = true
  local v = ownerInf + gain
  local cap = garrison * maxFactor
  if v > cap then v = cap end
  inf[owner] = v
else
  inf[attacker] = (inf[attacker] or 0) + gain
  if owner ~= 0 then inf[owner] = ownerInf end
  if inf[attacker] > ownerInf then
    if now >= shield then
      captured = true
      if owner ~= 0 then inf[owner] = math.floor(ownerInf / 2) end
      for f, v in pairs(inf) do
        if f ~= attacker and f ~= owner then
          local half = math.floor(v / 2)
          if half > 0 then inf[f] = half else inf[f] = nil end
        end
      end
      owner = attacker
      shield = now + shieldMs
    else
      shielded = true
    end
  end
end

-- 3. écriture
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 't', now, 's', shield)
for f, v in pairs(inf) do redis.call('HSET', KEYS[1], 'i:' .. f, v) end
local ver = redis.call('INCR', KEYS[6])
redis.call('HSET', KEYS[2], cityId, owner)
redis.call('HSET', KEYS[3], cityId, ver)
redis.call('SADD', KEYS[5], cityId)

local list = {}
for f, v in pairs(inf) do list[#list + 1] = { f, v } end
table.sort(list, function(a, b) return a[1] < b[1] end)
local finalInf = garrison
if owner ~= 0 then finalInf = math.max(inf[owner] or 0, garrison) end

local res = cjson.encode({
  owner = owner, prev = prev, captured = captured, defended = defended, shielded = shielded,
  ver = ver, ownerInf = finalInf, inf = list, shieldUntil = shield,
})
redis.call('SET', KEYS[4], res, 'EX', ttl)
return res
`;
