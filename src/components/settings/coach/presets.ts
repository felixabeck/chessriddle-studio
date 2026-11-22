/**
 * Services the connection form can prefill. This is renderer data only: the native side treats
 * every API connection alike and decides from the address alone what it may reach. The names are
 * product names and stay untranslated.
 */
export type CoachPresetId =
    | "openai"
    | "gemini"
    | "deepseek"
    | "qwen"
    | "openrouter"
    | "ollama"
    | "lmstudio"
    | "custom";

export type CoachPreset = {
    id: CoachPresetId;
    /** Product name; `null` for the free-form entry, whose label is translated. */
    name: string | null;
    address: string;
    /** Whether the service runs on this computer and normally needs no key. */
    local: boolean;
};

export const COACH_PRESETS: readonly CoachPreset[] = [
    { id: "openai", name: "OpenAI", address: "https://api.openai.com/v1", local: false },
    {
        id: "gemini",
        name: "Google Gemini",
        address: "https://generativelanguage.googleapis.com/v1beta/openai",
        local: false,
    },
    { id: "deepseek", name: "DeepSeek", address: "https://api.deepseek.com", local: false },
    {
        id: "qwen",
        name: "Qwen (Alibaba Cloud)",
        address: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        local: false,
    },
    { id: "openrouter", name: "OpenRouter", address: "https://openrouter.ai/api/v1", local: false },
    { id: "ollama", name: "Ollama", address: "http://localhost:11434/v1", local: true },
    { id: "lmstudio", name: "LM Studio", address: "http://localhost:1234/v1", local: true },
    { id: "custom", name: null, address: "", local: false },
];

export function coachPreset(id: string | null): CoachPreset {
    return COACH_PRESETS.find((preset) => preset.id === id) ?? COACH_PRESETS[0];
}
