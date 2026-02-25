export function renderAutoOpenCodeCliHelp(prefix: string): string {
  return [
    `OpenCode command mode is available with the ${prefix} prefix.`,
    "",
    "Onboarding:",
    `- ${prefix} start`,
    "",
    "CLI shortcuts:",
    `- ${prefix} usage <model> [--days N] [--project KEY]`,
    `- ${prefix} stats [--days N] [--models [N]] [--project KEY]`,
    `- ${prefix} models [provider] [--verbose] [--refresh]`,
    `- ${prefix} model [<model-id>|reset]`,
    `- ${prefix} help`,
  ].join("\n");
}

export function renderGuidedStartFlow(commandPrefix: string): string {
  return [
    "Guided onboarding (first 10 minutes):",
    "",
    "1) Confirm command wiring",
    `   - Run: ${commandPrefix} help`,
    "   - Expected: command list appears in this room",
    "",
    "2) Confirm OpenCode CLI availability",
    `   - Run: ${commandPrefix} models --verbose`,
    "   - Expected: available providers/models list",
    "",
    "3) Check project model override",
    `   - Run: ${commandPrefix} model`,
    `   - Optional: set one with ${commandPrefix} model <model-id>`,
    "",
    "4) Send your first real task",
    "   - Example prompt: Summarize this repository architecture in 5 bullets.",
    "",
    "5) Validate control flow",
    "   - Send: stop",
    "   - Expected: active job is cancelled and the bot waits for next instruction",
    "",
    "When all 5 steps pass, onboarding is complete.",
  ].join("\n");
}

export function renderGeneralHelp(commandPrefix: string, managementCommandPrefix: string): string {
  return [
    "Available commands:",
    "",
    "General commands:",
    "- !help - Show this help message",
    "- stop - Stop the current running job and wait",
    "",
    "OpenCode CLI commands:",
    `- ${commandPrefix} start`,
    `- ${commandPrefix} usage <model> [--days N] [--project KEY]`,
    `- ${commandPrefix} stats [--days N] [--models [N]] [--project KEY]`,
    `- ${commandPrefix} models [provider] [--verbose] [--refresh]`,
    `- ${commandPrefix} model [<model-id>|reset]`,
    `- ${commandPrefix} help`,
    "",
    "Project management commands (management room only):",
    `- ${managementCommandPrefix} list`,
    `- ${managementCommandPrefix} create <name> --room <roomId> --path <directory>`,
    `- ${managementCommandPrefix} delete <name>`,
    `- ${managementCommandPrefix} show <name>`,
    `- ${managementCommandPrefix} reload`,
    `- ${managementCommandPrefix} help`,
    "",
    `Tip: run ${managementCommandPrefix} help in the management room for command examples.`,
  ].join("\n");
}
