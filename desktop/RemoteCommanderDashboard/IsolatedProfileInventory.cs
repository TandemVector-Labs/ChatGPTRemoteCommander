using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace RemoteCommander;

// Local, read-only inventory. A record is not proof that a live MCP is healthy.
// No tunnels, credentials, authorization or arbitrary profile paths are accessed.
internal sealed record IsolatedProfileRecord(string Name, int Port, string ConfigSha256);

internal static class IsolatedProfileInventory
{
    internal static IReadOnlyList<IsolatedProfileRecord> Discover(string stateRoot)
    {
        var results = new List<IsolatedProfileRecord>();
        var root = Path.Combine(stateRoot, "instances");
        if (!Directory.Exists(root)) return results;
        try
        {
            foreach (var dir in Directory.EnumerateDirectories(root))
            {
                try
                {
                    var info = new DirectoryInfo(dir);
                    if (info.Attributes.HasFlag(FileAttributes.ReparsePoint)) continue;
                    var name = info.Name;
                    if (!Regex.IsMatch(name, @"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$") ||
                        name.Contains("..", StringComparison.Ordinal) ||
                        name.Equals("default", StringComparison.OrdinalIgnoreCase)) continue;
                    var recordFile = Path.Combine(dir, "instance.json");
                    var configFile = Path.Combine(dir, "config.json");
                    var recordInfo = new FileInfo(recordFile);
                    var configInfo = new FileInfo(configFile);
                    if (!recordInfo.Exists || !configInfo.Exists ||
                        recordInfo.Attributes.HasFlag(FileAttributes.ReparsePoint) ||
                        configInfo.Attributes.HasFlag(FileAttributes.ReparsePoint) ||
                        recordInfo.Length is <= 0 or > 16384 ||
                        configInfo.Length is <= 0 or > 262144) continue;
                    using var record = JsonDocument.Parse(File.ReadAllText(recordFile));
                    var r = record.RootElement;
                    if (r.GetProperty("schema").GetInt32() != 1 ||
                        !r.GetProperty("enabled").GetBoolean() ||
                        !r.GetProperty("isolated").GetBoolean() ||
                        !string.Equals(r.GetProperty("profile").GetString(), name, StringComparison.Ordinal) ||
                        !string.Equals(Path.GetFullPath(r.GetProperty("configPath").GetString() ?? ""),
                            Path.GetFullPath(configFile), StringComparison.OrdinalIgnoreCase)) continue;
                    var port = r.GetProperty("mcpPort").GetInt32();
                    if (port is < 1024 or > 65535 or 47831) continue;
                    var sha = r.GetProperty("configSha256").GetString() ?? "";
                    if (!Regex.IsMatch(sha, "^[a-f0-9]{64}$")) continue;
                    var bytes = File.ReadAllBytes(configFile);
                    if (bytes.Length > 262144 ||
                        !string.Equals(Convert.ToHexString(SHA256.HashData(bytes)),
                            sha, StringComparison.OrdinalIgnoreCase)) continue;
                    using var config = JsonDocument.Parse(bytes);
                    var c = config.RootElement;
                    if (c.GetProperty("port").GetInt32() != port ||
                        !string.Equals(c.GetProperty("instance").GetProperty("profile").GetString(),
                            name, StringComparison.Ordinal) ||
                        !c.GetProperty("instance").GetProperty("isolated").GetBoolean()) continue;
                    results.Add(new IsolatedProfileRecord(name, port, sha));
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                    or JsonException or InvalidOperationException or ArgumentException
                    or KeyNotFoundException or System.Security.SecurityException) { }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
            or System.Security.SecurityException) { }
        return results;
    }
}
