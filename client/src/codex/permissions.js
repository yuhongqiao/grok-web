export const sandboxLabels = { "read-only": "只读", readOnly: "只读", "workspace-write": "工作区写入", workspaceWrite: "工作区写入", "danger-full-access": "完全访问", dangerFullAccess: "完全访问", externalSandbox: "外部沙箱" };
export const approvalLabels = { untrusted: "不受信任命令需审批", "on-request": "按需审批", never: "从不审批" };
export const granularFields = [["sandbox_approval", "沙箱外执行"], ["rules", "命令规则审批"], ["mcp_elicitations", "MCP 表单与验证"], ["request_permissions", "额外权限申请"], ["skill_approval", "技能审批"]];

export function profileLabel(id) {
  return { ":read-only": "只读", ":workspace": "工作区写入", ":danger-full-access": "完全访问" }[id] || id;
}

export function approvalLabel(policy) {
  return approvalLabels[policy] || (policy?.granular ? `自定义审批（${granularFields.filter(([key]) => policy.granular[key]).map(([, label]) => label).join("、") || "全部关闭"}）` : policy ? JSON.stringify(policy) : "CLI 默认审批");
}

export function permissionLabel(settings) {
  const id = settings.activePermissionProfile?.id;
  const scope = sandboxLabels[settings.sandbox?.type];
  return id ? `${profileLabel(id)}${scope && scope !== profileLabel(id) ? ` · ${scope}` : ""}` : scope || "CLI 默认权限";
}

export const permissionPresets = [
  { mode: "read-only", profile: ":read-only", label: "只读", approvalPolicy: "on-request", description: "只读访问，需要额外权限时申请确认" },
  { mode: "workspace-write", profile: ":workspace", label: "工作区写入", approvalPolicy: "on-request", description: "允许修改工作区，需要额外权限时申请确认" },
  { mode: "danger-full-access", profile: ":danger-full-access", label: "完全访问", approvalPolicy: "never", description: "不限制文件和网络访问，不再请求操作审批" },
];
