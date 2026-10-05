export function workspaceAiFailure(error: unknown) {
  const details = error && typeof error === "object" ? error as { status?: unknown; name?: unknown } : {};
  const providerStatus = typeof details.status === "number" ? details.status : null;
  const name = typeof details.name === "string" ? details.name : "Error";
  if (name === "APIConnectionTimeoutError") {
    return { status: 504, code: "AI_TIMEOUT", providerStatus, error: "AI guidance took too long to respond. Your question was not saved; please retry." };
  }
  if (providerStatus === 429) {
    return { status: 429, code: "AI_RATE_LIMITED", providerStatus, error: "AI provider is temporarily rate-limited. Your question was not saved; wait briefly, then retry." };
  }
  if (providerStatus === 401 || providerStatus === 403) {
    return { status: 503, code: "AI_ACCESS_REJECTED", providerStatus, error: "AI provider access was rejected. Your question was not saved; contact the workspace administrator to restore access." };
  }
  if (providerStatus === 400 || providerStatus === 404 || providerStatus === 422) {
    return { status: 502, code: "AI_REQUEST_REJECTED", providerStatus, error: "AI provider rejected the configured model or request. Your question was not saved; contact the workspace administrator." };
  }
  return { status: 503, code: "AI_UNAVAILABLE", providerStatus, error: "AI guidance is temporarily unavailable. Your question was not saved; try again later." };
}