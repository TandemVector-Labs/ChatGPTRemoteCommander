using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;

namespace RemoteCommander;

/// <summary>
/// Owner-local Notion REST enrollment. The secret stays in the masked form
/// and the stdin pipe to the local importer; it is never passed in argv,
/// environment variables, exception dialogs, telemetry or command logs.
/// </summary>
internal sealed class NotionSetupForm : Form
{
    private readonly TextBox profile = new() { Text = "default", Width = 360, MaxLength = 80 };
    private readonly TextBox secret = new() { Width = 490, UseSystemPasswordChar = true, MaxLength = 1024 };
    private readonly CheckBox showToken = new() { Text = "Show token temporarily", AutoSize = true };
    private readonly CheckBox replaceExisting = new() { Text = "Replace existing REST credential (requires confirmation)", AutoSize = true };
    private readonly Label status = new() { Text = "Notion REST is separate from the hosted Notion MCP connection.", AutoSize = false, Width = 535, Height = 60 };
    private readonly Button connect = new() { Text = "Verify and connect", Width = 165, Height = 38 };
    private readonly Button portal = new() { Text = "Create token in Notion", Width = 185, Height = 38 };
    private readonly Button checkStatus = new() { Text = "Check status", Width = 115, Height = 38 };
    private readonly Button verify = new() { Text = "Verify access", Width = 125, Height = 38 };
    private readonly Button disconnect = new() { Text = "Disconnect", Width = 125, Height = 38 };
    private readonly Button close = new() { Text = "Close", Width = 105, Height = 38 };
    private readonly Color muted = Color.FromArgb(174, 193, 214);
    private bool connecting;

    public NotionSetupForm()
    {
        Text = "Remote Commander — Notion connection";
        AccessibleName = "Remote Commander Control Center — Notion setup";
        StartPosition = FormStartPosition.CenterScreen;
        Width = 800;
        Height = 545;
        MinimumSize = new Size(710, 525);
        Font = new Font("Segoe UI", 10);
        BackColor = Color.FromArgb(19, 30, 45);
        ForeColor = Color.White;

        var content = new TableLayoutPanel
        {
            Dock = DockStyle.Fill, Padding = new Padding(22), ColumnCount = 1,
            RowCount = 11, AutoScroll = true
        };
        content.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        foreach (int height in new[] { 48, 50, 32, 40, 28, 42, 34, 36, 26, 57, 95 })
            content.RowStyles.Add(new RowStyle(SizeType.Absolute, height));
        Controls.Add(content);

        var title = Label("Connect Notion", 21, Color.White);
        title.Font = new Font("Segoe UI Semibold", 19, FontStyle.Bold);
        content.Controls.Add(title, 0, 0);
        content.Controls.Add(Label("1. Create a Personal Access Token with Notion API permissions. 2. Enter it here. Token is verified and stored in the OS vault.", 9, muted), 0, 1);
        content.Controls.Add(Label("Commander profile (separate account vault)", 9, muted), 0, 2);
        profile.Dock = DockStyle.Fill;
        content.Controls.Add(profile, 0, 3);
        content.Controls.Add(Label("Notion REST Personal Access Token", 9, muted), 0, 4);
        secret.Dock = DockStyle.Fill;
        content.Controls.Add(secret, 0, 5);

        var controls = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = false };
        showToken.CheckedChanged += (_, _) => secret.UseSystemPasswordChar = !showToken.Checked;
        controls.Controls.Add(showToken);
        content.Controls.Add(controls, 0, 6);
        replaceExisting.ForeColor = muted;
        content.Controls.Add(replaceExisting, 0, 7);
        content.Controls.Add(new Label { Text = "No token is sent to ChatGPT, logs or the system clipboard by this form.", AutoSize = true, ForeColor = muted }, 0, 8);

        status.ForeColor = Color.FromArgb(147, 197, 253);
        content.Controls.Add(status, 0, 9);
        var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = true };
        foreach (var b in new[] { portal, connect, checkStatus, verify, disconnect, close })
        {
            b.BackColor = Color.FromArgb(37, 58, 82);
            b.ForeColor = Color.White;
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderColor = Color.FromArgb(93, 147, 212);
            buttons.Controls.Add(b);
        }
        content.Controls.Add(buttons, 0, 10);
        AcceptButton = connect;
        portal.Click += (_, _) => OpenOfficialPortal();
        connect.Click += async (_, _) => await ConnectAsync();
        checkStatus.Click += async (_, _) => await RefreshStatusAsync();
        verify.Click += async (_, _) => await ManageAsync(disconnectCredential: false);
        disconnect.Click += async (_, _) => await ManageAsync(disconnectCredential: true);
        Shown += async (_, _) => await RefreshStatusAsync();
        close.Click += (_, _) => Close();
        FormClosing += (_, e) => { if (connecting) e.Cancel = true; };
    }

    private static Label Label(string text, int size, Color color) => new()
    {
        Text = text, AutoSize = false, Dock = DockStyle.Fill,
        Font = new Font("Segoe UI", size), ForeColor = color, TextAlign = ContentAlignment.MiddleLeft
    };

    private static void OpenOfficialPortal()
    {
        try
        {
            Process.Start(new ProcessStartInfo("https://app.notion.com/developers/tokens") { UseShellExecute = true });
        }
        catch
        {
            MessageBox.Show("Open https://app.notion.com/developers/tokens in your signed-in browser.",
                "Notion", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }

    // Production Core is installed per user. The override is solely for
    // explicit, developer-controlled preview testing; no arbitrary file URLs.
    private static string FindImporter()
    {
        var overrideRoot = Environment.GetEnvironmentVariable("REMOTE_COMMANDER_NOTION_CLI_ROOT");
        var basePath = string.IsNullOrWhiteSpace(overrideRoot)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ChatGPTRemoteCommander", "app")
            : Path.GetFullPath(overrideRoot);
        var file = Path.GetFullPath(Path.Combine(basePath, "tools", "notion-pat-import.mjs"));
        var expected = Path.GetFullPath(Path.Combine(basePath, "tools"))
            .TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!file.StartsWith(expected, StringComparison.OrdinalIgnoreCase) || !File.Exists(file))
            throw new InvalidOperationException("NOTION_REST_MODULE_NOT_INSTALLED");
        return file;
    }

    private async Task RefreshStatusAsync()
    {
        if (connecting) return;
        var currentProfile = profile.Text.Trim();
        if (!System.Text.RegularExpressions.Regex.IsMatch(currentProfile, @"^[A-Za-z0-9_-]{1,80}$"))
        {
            status.Text = "Enter a valid Commander profile.";
            return;
        }
        checkStatus.Enabled = false;
        try
        {
            var start = new ProcessStartInfo
            {
                FileName = "node", UseShellExecute = false,
                RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true
            };
            start.ArgumentList.Add(FindImporter());
            start.ArgumentList.Add("--status");
            start.ArgumentList.Add("--profile");
            start.ArgumentList.Add(currentProfile);
            using var process = new Process { StartInfo = start };
            if (!process.Start()) throw new InvalidOperationException("STATUS_START_FAILED");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            try { await process.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException)
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                status.Text = "Connection status is unavailable.";
                return;
            }
            var output = (await process.StandardOutput.ReadToEndAsync()).Trim();
            if (process.ExitCode != 0 || !output.StartsWith("NOTION_REST_STATUS ", StringComparison.Ordinal))
                throw new InvalidOperationException("STATUS_INVALID");
            if (output.Contains(" CONNECTED ", StringComparison.Ordinal))
            {
                status.ForeColor = Color.FromArgb(107, 224, 170);
                status.Text = output.Contains(" PAT ", StringComparison.Ordinal)
                    ? "Notion REST connected (personal access token in protected OS vault)."
                    : "Notion REST connected (OAuth credential in protected OS vault).";
            }
            else
            {
                status.ForeColor = muted;
                status.Text = output.Contains("VAULT_UNAVAILABLE", StringComparison.Ordinal)
                    ? "Credential vault unavailable. Check the local user session."
                    : "Notion REST not connected for this Commander profile.";
            }
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception or System.IO.IOException)
        {
            status.Text = e.Message == "NOTION_REST_MODULE_NOT_INSTALLED"
                ? "Install a compatible Commander Core version before connecting Notion."
                : "Local Notion status could not be checked.";
        }
        finally { checkStatus.Enabled = true; }
    }

    private async Task ManageAsync(bool disconnectCredential)
    {
        if (connecting) return;
        var selectedProfile = profile.Text.Trim();
        if (!System.Text.RegularExpressions.Regex.IsMatch(selectedProfile, @"^[A-Za-z0-9_-]{1,80}$"))
        {
            status.Text = "Select a valid Commander profile.";
            return;
        }
        if (disconnectCredential && MessageBox.Show(this,
            $"Remove the local Notion REST credential for profile '{selectedProfile}'?\n" +
            "This does not revoke the token in Notion or disconnect hosted Notion MCP.",
            "Confirm Notion REST disconnect", MessageBoxButtons.YesNo, MessageBoxIcon.Warning)
            != DialogResult.Yes) return;
        connecting = true;
        connect.Enabled = false;
        verify.Enabled = false;
        disconnect.Enabled = false;
        checkStatus.Enabled = false;
        close.Enabled = false;
        secret.Clear();
        status.Text = disconnectCredential ? "Removing this profile's local credential..." :
            "Checking live Notion REST access...";
        try
        {
            var start = new ProcessStartInfo
            {
                FileName = "node", UseShellExecute = false,
                RedirectStandardOutput = true, RedirectStandardError = true,
                CreateNoWindow = true
            };
            start.ArgumentList.Add(FindImporter());
            start.ArgumentList.Add(disconnectCredential ? "--disconnect" : "--verify");
            if (disconnectCredential) start.ArgumentList.Add("--confirm-disconnect");
            start.ArgumentList.Add("--profile");
            start.ArgumentList.Add(selectedProfile);
            using var process = new Process { StartInfo = start };
            if (!process.Start()) throw new InvalidOperationException("NOTION_ACTION_START_FAILED");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(25));
            try { await process.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException)
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                status.Text = "Notion operation timed out. Check connection status.";
                return;
            }
            var output = (await process.StandardOutput.ReadToEndAsync()).Trim();
            if (process.ExitCode == 0 && output ==
                (disconnectCredential ? "NOTION_REST_DISCONNECTED" : "NOTION_REST_VERIFIED"))
            {
                status.ForeColor = disconnectCredential ? muted : Color.FromArgb(107, 224, 170);
                status.Text = disconnectCredential
                    ? "Disconnected local Notion REST credential for this profile. Hosted MCP is unchanged."
                    : "Verified: Notion REST credentials have live access.";
            }
            else
            {
                status.ForeColor = muted;
                status.Text = "Notion operation could not be verified. Use Check status; credentials were not printed.";
            }
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception or System.IO.IOException)
        {
            status.Text = e.Message == "NOTION_REST_MODULE_NOT_INSTALLED"
                ? "Install a compatible Commander Core before managing Notion."
                : "Notion management is unavailable.";
        }
        finally
        {
            secret.Clear();
            connecting = false;
            connect.Enabled = true;
            verify.Enabled = true;
            disconnect.Enabled = true;
            checkStatus.Enabled = true;
            close.Enabled = true;
        }
    }

    private async Task ConnectAsync()
    {
        if (connecting) return;
        var selectedProfile = profile.Text.Trim();
        if (!System.Text.RegularExpressions.Regex.IsMatch(selectedProfile, @"^[A-Za-z0-9_-]{1,80}$"))
        {
            status.Text = "Invalid profile. Use letters, numbers, _ and -.";
            return;
        }

        var token = secret.Text;
        // Fail before launching a process. Never echo the provided value.
        if (!System.Text.RegularExpressions.Regex.IsMatch(token, @"^[A-Za-z0-9._-]{24,512}$"))
        {
            status.Text = "Invalid token format. Copy the complete token from the official Notion portal.";
            secret.Clear();
            return;
        }

        if (replaceExisting.Checked &&
            MessageBox.Show(this, "Replace the existing Notion REST credential for this profile?",
                "Confirm credential replacement", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
        {
            token = string.Empty;
            return;
        }

        connecting = true;
        connect.Enabled = false;
        close.Enabled = false;
        status.Text = "Verifying token with Notion…";
        secret.Clear(); // Remove from the UI immediately.
        try
        {
            var importer = FindImporter();
            var start = new ProcessStartInfo
            {
                FileName = "node", UseShellExecute = false, RedirectStandardInput = true,
                RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true
            };
            start.ArgumentList.Add(importer);
            start.ArgumentList.Add("--token-stdin");
            start.ArgumentList.Add("--profile");
            start.ArgumentList.Add(selectedProfile);
            if (replaceExisting.Checked) start.ArgumentList.Add("--replace-existing");

            using var process = new Process { StartInfo = start };
            if (!process.Start()) throw new InvalidOperationException("NOTION_IMPORTER_START_FAILED");
            await process.StandardInput.WriteLineAsync(token);
            token = string.Empty; // Do not keep an additional reference after stdin write.
            await process.StandardInput.FlushAsync();
            process.StandardInput.Close();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(25));
            try { await process.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException)
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                status.Text = "Notion verification timed out. No connection was confirmed.";
                return;
            }
            var ok = (await process.StandardOutput.ReadToEndAsync()).Trim();
            var error = (await process.StandardError.ReadToEndAsync()).Trim();
            if (process.ExitCode == 0 && ok == "NOTION_REST_PAT_VERIFIED_AND_SAVED_IN_OS_VAULT")
            {
                status.ForeColor = Color.FromArgb(107, 224, 170);
                status.Text = "Connected. Token verified by Notion and stored in this user's protected REST vault.";
            }
            else
            {
                var known = new HashSet<string>
                {
                    "NOTION_PAT_UNAUTHORIZED", "NOTION_PAT_VERIFICATION_FAILED",
                    "NOTION_PAT_VERIFICATION_UNAVAILABLE", "NOTION_ALREADY_CONNECTED",
                    "NOTION_VAULT_UNAVAILABLE", "NOTION_PAT_INVALID_FORMAT",
                    "NOTION_DISABLED", "NOTION_PAT_IMPORT_FAILED"
                };
                status.Text = known.Contains(error) ? $"Not connected: {error}" : "Notion connection failed. No credential was confirmed.";
            }
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception or System.IO.IOException)
        {
            status.Text = e.Message == "NOTION_REST_MODULE_NOT_INSTALLED"
                ? "Install a Commander Core version with Notion REST support first."
                : "The local Notion importer is unavailable.";
        }
        finally
        {
            token = string.Empty;
            secret.Clear();
            connecting = false;
            connect.Enabled = true;
            close.Enabled = true;
        }
    }
}
