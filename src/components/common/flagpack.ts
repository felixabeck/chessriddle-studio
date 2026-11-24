export async function loadFlagpack() {
    const [Flags, countries] = await Promise.all([
        import("mantine-flagpack"),
        import("./countries.json"),
    ]);
    return {
        flags: Object.entries(Flags).map(([key, value]) => ({
            key: key.replace("Flag", ""),
            component: value,
        })),
        countries: countries.default,
    };
}
