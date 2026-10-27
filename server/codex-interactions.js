import { HttpError } from "./sessions.js";

function stringFormat(value, format) {
  if (format === "email") return /^[^\s@]+@[^\s@]+$/.test(value);
  if (format === "uri") return !/\s/.test(value) && URL.canParse(value);
  if (format === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  if (format === "date-time") {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})[tT](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[zZ]|[+-](\d{2}):(\d{2}))$/);
    return Boolean(match && stringFormat(match[1], "date") && +match[2] < 24 && +match[3] < 60 && +match[4] <= 60 && +(match[5] || 0) < 24 && +(match[6] || 0) < 60);
  }
  return true;
}

export function interactionResult(request, body) {
  const p = request.params;
  if (request.method === "item/tool/requestUserInput") {
    if (body.skip === true) return { answers: {} };
    const answers = Object.create(null);
    for (const question of p.questions) {
      const value = body.answers?.[question.id];
      if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "请回答所有问题，或选择跳过");
      answers[question.id] = { answers: [value.trim()] };
    }
    return { answers };
  }
  if (request.method === "mcpServer/elicitation/request") {
    if (!["accept", "decline", "cancel"].includes(body.action)) throw new HttpError(400, "请选择提交、拒绝或取消");
    if (body.action !== "accept") return { action: body.action };
    if (p.mode === "url" && /^https?:\/\//i.test(p.url)) return { action: "accept", content: null };
    if (!["form", "openai/form", "openaiForm"].includes(p.mode) || p.requestedSchema?.type !== "object") throw new HttpError(400, "此验证类型需要在支持它的客户端完成");
    const content = Object.create(null);
    for (const [key, schema] of Object.entries(p.requestedSchema.properties || {})) {
      const value = Object.hasOwn(body.content || {}, key) ? body.content[key] : schema.default;
      const required = p.requestedSchema.required?.includes(key);
      if (value === undefined || value === null || value === "") {
        if (required) throw new HttpError(400, `请填写 ${schema.title || key}`);
        continue;
      }
      let valid = false;
      if (schema.type === "string") valid = typeof value === "string" && (!schema.enum || schema.enum.includes(value)) && (!schema.oneOf || schema.oneOf.some((entry) => entry.const === value)) && (schema.minLength == null || value.length >= schema.minLength) && (schema.maxLength == null || value.length <= schema.maxLength) && stringFormat(value, schema.format);
      if (schema.type === "boolean") valid = typeof value === "boolean";
      if (["number", "integer"].includes(schema.type)) valid = typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isInteger(value)) && (schema.minimum == null || value >= schema.minimum) && (schema.maximum == null || value <= schema.maximum);
      if (schema.type === "array") valid = Array.isArray(value) && value.every((entry) => typeof entry === "string" && (!schema.items?.enum || schema.items.enum.includes(entry)) && (!schema.items?.anyOf || schema.items.anyOf.some((option) => option.const === entry))) && (schema.minItems == null || value.length >= schema.minItems) && (schema.maxItems == null || value.length <= schema.maxItems) && new Set(value).size === value.length;
      if (!valid) throw new HttpError(400, `${schema.title || key} 的内容不符合要求`);
      content[key] = value;
    }
    return { action: "accept", content };
  }
  if (request.method === "item/permissions/requestApproval") {
    if (!["accept", "decline"].includes(body.decision)) throw new HttpError(400, "请选择允许或拒绝");
    return { permissions: body.decision === "accept" ? p.permissions : {}, scope: "turn" };
  }
  const supported = request.method === "item/commandExecution/requestApproval" && p.availableDecisions
    ? p.availableDecisions.filter((entry) => typeof entry === "string")
    : ["accept", "acceptForSession", "decline", "cancel"];
  if (!supported.includes(body.decision)) throw new HttpError(400, "此审批不支持所选决定");
  return { decision: body.decision };
}
