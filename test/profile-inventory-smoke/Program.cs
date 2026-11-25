using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RemoteCommander;

var temp = Path.Combine(Path.GetTempPath(), "rc-iso-inventory-fixture-" + Guid.NewGuid().ToString("N"));
var dir = Path.Combine(temp, "instances", "MMZ");
Directory.CreateDirectory(dir);
var config = Path.Combine(dir, "config.json");
var record = Path.Combine(dir, "instance.json");
try
{
    var bytes = Encoding.UTF8.GetBytes("""{"port":47836,"instance":{"profile":"MMZ","isolated":true}}""");
    // The fixture carries no Runtime API Key, tunnel data or private files.
    File.WriteAllBytes(config, bytes);
    var sha = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    void WriteRecord(int port, string id, string hash, bool isolated = true)
       => File.WriteAllText(record, JsonSerializer.Serialize(new {
           schema=1, profile=id, isolated, enabled=true, mcpPort=port,
           configPath=config, configSha256=hash
       }));
    void Require(bool assertion, string name) {
        if (!assertion) throw new Exception("FAIL: " + name);
        Console.WriteLine("PASS " + name);
    }
    WriteRecord(47836, "MMZ", sha);
    Require(IsolatedProfileInventory.Discover(temp).Any(x => x.Name == "MMZ" && x.Port == 47836), "valid isolated instance");
    WriteRecord(47836, "MMZ", new string('0',64));
    Require(IsolatedProfileInventory.Discover(temp).Count == 0, "forged config SHA denied");
    WriteRecord(47836, "OTHER", sha);
    Require(IsolatedProfileInventory.Discover(temp).Count == 0, "wrong profile identity denied");
    WriteRecord(47831, "MMZ", sha);
    Require(IsolatedProfileInventory.Discover(temp).Count == 0, "primary shared port denied");
    WriteRecord(47836, "MMZ", sha, false);
    Require(IsolatedProfileInventory.Discover(temp).Count == 0, "non-isolated record denied");
    WriteRecord(47836, "MMZ", sha);
    File.AppendAllText(config, " ");
    Require(IsolatedProfileInventory.Discover(temp).Count == 0, "changed config bytes denied");
    var live = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ChatGPTRemoteCommander");
    var liveRecord = Path.Combine(live,"instances","MMZ","instance.json");
    if (File.Exists(liveRecord))
        Require(IsolatedProfileInventory.Discover(live).Any(x => x.Name == "MMZ" && x.Port == 47836),
            "live MMZ inventory recognized");
    Console.WriteLine("ISOLATED_PROFILE_INVENTORY_TEST_PASS");
}
finally
{
    if (Directory.Exists(temp)) Directory.Delete(temp, true);
}