using System.Globalization;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

internal static class Program
{
    private const int MaxMessageBytes = 4096;
    private const int MaxSkewMs = 10_000;
    private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(15);
    private static readonly SecurityIdentifier SystemSid = new(WellKnownSidType.LocalSystemSid, null);
    private static readonly SecurityIdentifier AdminSid = new(WellKnownSidType.BuiltinAdministratorsSid, null);

    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);

    private static async Task<int> Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("WINDOWS_ONLY");
            if (args.Length == 1 && args[0] == "self-test")
            {
                SelfTest();
                Console.WriteLine("OWNER_GUI_BRIDGE_CRYPTO_SCHEMA_SELFTEST_PASS");
                return 0;
            }
            if (args.Length != 7 || (args[0] != "serve" && args[0] != "probe")
                || args[1] != "--pipe" || args[3] != "--key-file" || args[5] != "--owner-sid")
                throw new InvalidOperationException("ARGUMENT_SCHEMA");

            var role = args[0];
            var pipeName = args[2];
            var file = Path.GetFullPath(args[4]);
            if (!Regex.IsMatch(pipeName, @"^rcgui-[a-f0-9]{24}$", RegexOptions.CultureInvariant))
                throw new InvalidOperationException("PIPE_NAME_INVALID");
            var owner = new SecurityIdentifier(args[6]);
            if (owner.IsWellKnown(WellKnownSidType.LocalSystemSid)
                || owner.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid))
                throw new InvalidOperationException("OWNER_SID_INVALID");

            var current = WindowsIdentity.GetCurrent();
            if (role == "serve")
            {
                if (current.User != owner || current.IsSystem || Environment.ProcessId < 1
                    || System.Diagnostics.Process.GetCurrentProcess().SessionId == 0
                    || !Environment.UserInteractive)
                    throw new InvalidOperationException("OWNER_SESSION_INVALID");
            }
            else
            {
                if (!current.IsSystem || System.Diagnostics.Process.GetCurrentProcess().SessionId != 0)
                    throw new InvalidOperationException("CORE_SERVICE_SESSION_INVALID");
            }

            var key = ReadPrivateKey(file, owner);
            try
            {
                using var timeout = new CancellationTokenSource(Deadline);
                if (role == "serve") await Serve(pipeName, owner, key, timeout.Token);
                else await Probe(pipeName, owner, key, timeout.Token);
            }
            finally { CryptographicOperations.ZeroMemory(key); }
            return 0;
        }
        catch (Exception error)
        {
            // Never print exception messages, paths, HMACs, pipe names or key bytes.
            var known = error is InvalidOperationException ex && Regex.IsMatch(ex.Message, @"^[A-Z_]{3,48}$")
                ? ex.Message
                : error is OperationCanceledException ? "DEADLINE"
                : error is UnauthorizedAccessException ? "ACCESS_DENIED"
                : error is FileNotFoundException ? "KEY_UNAVAILABLE"
                : "BRIDGE_FAILED";
            Console.Error.WriteLine(known);
            return 1;
        }
    }

    private static void SelfTest()
    {
        var key = RandomNumberGenerator.GetBytes(32);
        try
        {
            var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
            var utc = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var expected = Mac(key, RequestMaterial(nonce, utc));
            if (!SecureMac(expected, expected) || SecureMac(expected, new string('0', 64)))
                throw new InvalidOperationException("SELFTEST_HMAC");
            var reply = Mac(key, ResponseMaterial(nonce, "S-1-5-21-1", 1, 3440, 1440, true));
            if (!SecureMac(reply, reply) || SecureMac(reply, Mac(key,
                    ResponseMaterial(nonce, "S-1-5-21-1", 0, 3440, 1440, true))))
                throw new InvalidOperationException("SELFTEST_BINDING");

            var valid = Encoding.UTF8.GetBytes("{\"v\":1,\"action\":\"status\",\"nonce\":\"X\",\"utc\":1,\"mac\":\"X\"}");
            var parsed = ParseStrict(valid, "v", "action", "nonce", "utc", "mac");
            if (Property(parsed, "action") != "status" || IntProperty(parsed, "v") != 1)
                throw new InvalidOperationException("SELFTEST_SCHEMA");
            foreach (var invalid in new[] {
                "{\"v\":1,\"action\":\"status\",\"nonce\":\"X\",\"utc\":1,\"mac\":\"X\",\"extra\":1}",
                "{\"v\":1,\"v\":1,\"action\":\"status\",\"nonce\":\"X\",\"utc\":1,\"mac\":\"X\"}",
                "{\"v\":1,\"action\":\"screenshot\",\"nonce\":\"X\",\"utc\":1,\"mac\":\"X\",\"extra\":1}"
            })
            {
                try { _ = ParseStrict(Encoding.UTF8.GetBytes(invalid),
                    "v", "action", "nonce", "utc", "mac"); }
                catch (InvalidOperationException) { continue; }
                throw new InvalidOperationException("SELFTEST_REJECT");
            }
        }
        finally { CryptographicOperations.ZeroMemory(key); }
    }
    private static byte[] ReadPrivateKey(string file, SecurityIdentifier owner)
    {
        var info = new FileInfo(file);
        info.Refresh();
        if (!info.Exists || info.Length != 32 || info.Attributes.HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidOperationException("KEY_UNAVAILABLE");
        var acl = FileSystemAclExtensions.GetAccessControl(info);
        if (!acl.AreAccessRulesProtected) throw new InvalidOperationException("KEY_ACL_INHERITED");
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow) continue;
            var sid = (SecurityIdentifier)rule.IdentityReference;
            if (sid != owner && sid != SystemSid && sid != AdminSid)
                throw new InvalidOperationException("KEY_ACL_TOO_BROAD");
        }
        var key = File.ReadAllBytes(file);
        if (key.Length != 32) throw new InvalidOperationException("KEY_LENGTH_INVALID");
        return key;
    }

    private static PipeSecurity BuildAcl(SecurityIdentifier owner)
    {
        var acl = new PipeSecurity();
        acl.SetAccessRuleProtection(true, false);
        acl.SetOwner(owner);
        acl.AddAccessRule(new PipeAccessRule(owner, PipeAccessRights.FullControl, AccessControlType.Allow));
        acl.AddAccessRule(new PipeAccessRule(SystemSid, PipeAccessRights.ReadWrite, AccessControlType.Allow));
        return acl;
    }

    private static string Mac(byte[] key, string material) =>
        Convert.ToHexString(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(material)));

    private static bool SecureMac(string received, string expected)
    {
        if (received.Length != 64 || !Regex.IsMatch(received, @"^[A-F0-9]{64}$")) return false;
        var a = Convert.FromHexString(received);
        var b = Convert.FromHexString(expected);
        return CryptographicOperations.FixedTimeEquals(a, b);
    }

    private static string RequestMaterial(string nonce, long unixMs) =>
        string.Concat("v1|status|", nonce, "|", unixMs.ToString(CultureInfo.InvariantCulture));

    private static string ResponseMaterial(string nonce, string ownerSid, int session, int width, int height, bool interactive) =>
        string.Concat("v1|status-response|", nonce, "|", ownerSid, "|",
            session.ToString(CultureInfo.InvariantCulture), "|", width.ToString(CultureInfo.InvariantCulture),
            "|", height.ToString(CultureInfo.InvariantCulture), "|", interactive ? "1" : "0");

    private static string Property(JsonElement root, string key)
    {
        if (!root.TryGetProperty(key, out var item) || item.ValueKind != JsonValueKind.String)
            throw new InvalidOperationException("MESSAGE_SCHEMA");
        return item.GetString()!;
    }

    private static int IntProperty(JsonElement root, string key)
    {
        if (!root.TryGetProperty(key, out var item) || !item.TryGetInt32(out var value))
            throw new InvalidOperationException("MESSAGE_SCHEMA");
        return value;
    }

    private static JsonElement ParseStrict(byte[] bytes, params string[] fields)
    {
        using var doc = JsonDocument.Parse(bytes);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("MESSAGE_SCHEMA");
        var actual = root.EnumerateObject().Select(x => x.Name).ToArray();
        if (actual.Length != fields.Length || actual.Distinct(StringComparer.Ordinal).Count() != fields.Length
            || fields.Except(actual, StringComparer.Ordinal).Any())
            throw new InvalidOperationException("MESSAGE_SCHEMA");
        return root.Clone();
    }

    private static async Task<byte[]> Receive(PipeStream pipe, CancellationToken cancel)
    {
        using var buffer = new MemoryStream();
        var single = new byte[1];
        while (buffer.Length < MaxMessageBytes)
        {
            var count = await pipe.ReadAsync(single, cancel);
            if (count != 1) throw new InvalidOperationException("MESSAGE_TRUNCATED");
            if (single[0] == (byte)'\n')
            {
                if (buffer.Length == 0) throw new InvalidOperationException("MESSAGE_EMPTY");
                return buffer.ToArray();
            }
            buffer.WriteByte(single[0]);
        }
        throw new InvalidOperationException("MESSAGE_TOO_LARGE");
    }

    private static async Task Send(PipeStream pipe, object data, CancellationToken cancel)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(data) + "\n");
        if (bytes.Length > MaxMessageBytes) throw new InvalidOperationException("MESSAGE_TOO_LARGE");
        await pipe.WriteAsync(bytes, cancel);
        await pipe.FlushAsync(cancel);
    }

    private static async Task Serve(string name, SecurityIdentifier owner, byte[] key, CancellationToken cancel)
    {
        using var pipe = NamedPipeServerStreamAcl.Create(name, PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0, BuildAcl(owner),
            HandleInheritability.None, (PipeAccessRights)0);
        Console.WriteLine("OWNER_SESSION_PIPE_READY");
        await pipe.WaitForConnectionAsync(cancel);
        var input = ParseStrict(await Receive(pipe, cancel), "v", "action", "nonce", "utc", "mac");
        if (IntProperty(input, "v") != 1 || Property(input, "action") != "status")
            throw new InvalidOperationException("ACTION_DENIED");
        var nonce = Property(input, "nonce");
        if (!Regex.IsMatch(nonce, @"^[A-F0-9]{32}$")) throw new InvalidOperationException("NONCE_INVALID");
        if (!input.GetProperty("utc").TryGetInt64(out var utc))
            throw new InvalidOperationException("MESSAGE_SCHEMA");
        if (Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - utc) > MaxSkewMs)
            throw new InvalidOperationException("TIMESTAMP_EXPIRED");
        if (!SecureMac(Property(input, "mac"), Mac(key, RequestMaterial(nonce, utc))))
            throw new InvalidOperationException("REQUEST_UNAUTHENTICATED");

        var session = System.Diagnostics.Process.GetCurrentProcess().SessionId;
        var width = GetSystemMetrics(0);
        var height = GetSystemMetrics(1);
        var interactive = Environment.UserInteractive;
        if (session <= 0 || width <= 0 || height <= 0 || !interactive)
            throw new InvalidOperationException("OWNER_DISPLAY_UNAVAILABLE");
        var sid = owner.Value;
        await Send(pipe, new {
            v = 1, action = "status-response", nonce, sid, session, width, height, interactive,
            mac = Mac(key, ResponseMaterial(nonce, sid, session, width, height, interactive))
        }, cancel);
        Console.WriteLine("OWNER_READONLY_STATUS_SENT");
    }

    private static async Task Probe(string name, SecurityIdentifier owner, byte[] key, CancellationToken cancel)
    {
        using var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut,
            PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
        await pipe.ConnectAsync(cancel);
        var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        var utc = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        await Send(pipe, new { v = 1, action = "status", nonce, utc,
            mac = Mac(key, RequestMaterial(nonce, utc)) }, cancel);
        var reply = ParseStrict(await Receive(pipe, cancel),
            "v", "action", "nonce", "sid", "session", "width", "height", "interactive", "mac");
        if (IntProperty(reply, "v") != 1 || Property(reply, "action") != "status-response"
            || Property(reply, "nonce") != nonce || Property(reply, "sid") != owner.Value)
            throw new InvalidOperationException("RESPONSE_IDENTITY_INVALID");
        var session = IntProperty(reply, "session");
        var width = IntProperty(reply, "width");
        var height = IntProperty(reply, "height");
        var interactive = reply.GetProperty("interactive");
        if (interactive.ValueKind != JsonValueKind.True || session <= 0 || width <= 0 || height <= 0)
            throw new InvalidOperationException("RESPONSE_DISPLAY_INVALID");
        if (!SecureMac(Property(reply, "mac"),
            Mac(key, ResponseMaterial(nonce, owner.Value, session, width, height, true))))
            throw new InvalidOperationException("RESPONSE_UNAUTHENTICATED");
        Console.WriteLine(JsonSerializer.Serialize(new {
            ok = true, protocol = 1, backend = "windows-owner-session-namedpipe-readonly",
            ownerSession = session, ownerDisplayWidth = width, ownerDisplayHeight = height,
            authenticated = true, operations = new[] { "status" },
            screenshot = false, mouse = false, keyboard = false, focus = false
        }));
    }
}
