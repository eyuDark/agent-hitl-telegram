export const RESOLVE_APPROVAL_LUA = `
local key = KEYS[1]
local expected_status = "PENDING"
local new_status = ARGV[1]
local resolved_by = ARGV[2]
local resolved_at = ARGV[3]
local reason = ARGV[4]
local answer_json = ARGV[5]

local current_status = redis.call("HGET", key, "status")
if not current_status then
  return {"NOT_FOUND", ""}
end
if current_status ~= expected_status then
  return {"ALREADY_RESOLVED", current_status}
end

redis.call("HSET", key,
  "status", new_status,
  "actorId", resolved_by,
  "resolvedAt", resolved_at,
  "resolutionReason", reason,
  "answerJson", answer_json
)
redis.call("EXPIRE", key, 86400)
return {"OK", new_status}
`;
