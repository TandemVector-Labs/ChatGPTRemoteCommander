using System.Text.Json;

namespace RemoteCommander;

// Read-only local profile evidence. Neither a login nor an authenticated same-chat ACK.
internal static class ProfileHealthEvidence
{
    private static bool Hash(string value, int size) =>
        value.Length == size && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
    private static bool Port(int value) => value is >= 1024 and <= 65535;
    internal static bool Plausible(ProfileRow p) =>
        !string.IsNullOrWhiteSpace(p.Name) && p.Name.Length <= 128 &&
        p.Generation > 0 && p.RouterPid > 0 && Port(p.RouterPort) && Port(p.BackendPort) &&
        Hash(p.Commit, 40) && Hash(p.RouterSourceSha256, 64) &&
        Hash(p.BackendConfigSha256, 64) && !string.IsNullOrWhiteSpace(p.Version);
    private static bool Equal(JsonElement e, string field, string target) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(field, out var v) &&
        v.ValueKind == JsonValueKind.String && v.GetString() == target;
    private static bool Equal(JsonElement e, string field, int target) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(field, out var v) &&
        v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) && n == target;
    private static bool True(JsonElement e, string field) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(field, out var v) &&
        v.ValueKind == JsonValueKind.True;
    internal static bool Matches(ProfileRow p, string routerJson, string backendJson)
    {
        if (!Plausible(p) || routerJson.Length > 262144 || backendJson.Length > 16384) return false;
        try
        {
            using var router = JsonDocument.Parse(routerJson);
            using var backend = JsonDocument.Parse(backendJson);
            var r = router.RootElement;
            if (!True(r, "ok") || !True(r, "router") ||
                !Equal(r, "listenPort", p.RouterPort) ||
                !Equal(r, "sourceSha256", p.RouterSourceSha256) ||
                !r.TryGetProperty("state", out var state) ||
                !Equal(state, "profile", p.Name) ||
                !Equal(state, "generation", p.Generation) ||
                !state.TryGetProperty("active", out var active) ||
                !Equal(active, "version", p.Version) ||
                !Equal(active, "commit", p.Commit) ||
                !Equal(active, "port", p.BackendPort) ||
                !Equal(active, "configSha256", p.BackendConfigSha256)) return false;
            var b = backend.RootElement;
            return True(b, "ok") &&
                Equal(b, "name", "chatgpt-remote-commander") &&
                Equal(b, "version", p.Version) &&
                Equal(b, "configSha256", p.BackendConfigSha256) &&
                b.TryGetProperty("instance", out var instance) &&
                Equal(instance, "profile", p.Name);
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or ArgumentException)
        {
            return false;
        }
    }
}
