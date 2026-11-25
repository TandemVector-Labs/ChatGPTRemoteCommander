using System.Drawing;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace RemoteCommander;

// Read-only, immutable build catalog. The catalog does not grant privileges or
// authorize downloads; a missing/invalid embedded payload fails closed.
internal sealed record OptionalAddonView(string Id, string Name, string Category, bool SupportsWindows);
internal static class OptionalAddonCatalog
{
    private const string ResourceName = "RemoteCommander.OptionalProducts";
    internal static IReadOnlyList<OptionalAddonView> Read()
    {
        try
        {
            using var stream = typeof(OptionalAddonCatalog).Assembly.GetManifestResourceStream(ResourceName);
            if (stream is null || stream.Length <= 0 || stream.Length > 32768)
                return Array.Empty<OptionalAddonView>();
            using var document = JsonDocument.Parse(stream, new JsonDocumentOptions { MaxDepth = 16 });
            var catalog = document.RootElement.GetProperty("controlCenterAddons");
            if (catalog.GetProperty("schema").GetInt32() != 1 ||
                catalog.GetProperty("surface").GetString() != "control-center" ||
                catalog.GetProperty("defaultAutoInstall").ValueKind != JsonValueKind.False ||
                catalog.GetProperty("capability").GetString() !=
                    "DISCOVERY_ONLY_UNTIL_SIGNED_ARTIFACT_AND_OWNER_GRANT")
                return Array.Empty<OptionalAddonView>();
            var items = catalog.GetProperty("items");
            if (items.ValueKind != JsonValueKind.Array || items.GetArrayLength() > 64)
                return Array.Empty<OptionalAddonView>();
            var output = new List<OptionalAddonView>();
            var ids = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in items.EnumerateArray())
            {
                var id = item.GetProperty("id").GetString() ?? "";
                var name = item.GetProperty("name").GetString() ?? "";
                var category = item.GetProperty("category").GetString() ?? "";
                var source = item.GetProperty("source").GetString() ?? "";
                var platforms = item.GetProperty("platforms");
                if (!Regex.IsMatch(id, "^[a-z][a-z0-9-]{1,48}$") ||
                    !ids.Add(id) || name.Length is < 1 or > 100 ||
                    category.Length is < 1 or > 80 ||
                    !Uri.TryCreate(source, UriKind.Absolute, out var uri) ||
                    uri.Scheme != Uri.UriSchemeHttps || uri.Host != "github.com" ||
                    uri.UserInfo.Length > 0 ||
                    item.GetProperty("admission").GetString() != "planned" ||
                    item.GetProperty("downloadDefault").ValueKind != JsonValueKind.False ||
                    platforms.ValueKind != JsonValueKind.Array)
                    return Array.Empty<OptionalAddonView>();
                bool supported = false;
                foreach (var platform in platforms.EnumerateArray())
                {
                    var value = platform.GetString();
                    if (value is not ("windows" or "linux"))
                        return Array.Empty<OptionalAddonView>();
                    if (value == "windows") supported = true;
                }
                output.Add(new OptionalAddonView(id, name, category, supported));
            }
            return output;
        }
        catch (Exception)
        {
            return Array.Empty<OptionalAddonView>();
        }
    }
}

internal sealed class OptionalAddonsForm : Form
{
    internal OptionalAddonsForm()
    {
        Text = "Remote Commander — Optional Add-ons";
        Width = 820;
        Height = 550;
        MinimumSize = new Size(640, 420);
        StartPosition = FormStartPosition.CenterParent;
        Font = new Font("Segoe UI", 10f);

        var note = new Label {
            Dock = DockStyle.Top, Height = 78, Padding = new Padding(16, 14, 16, 4),
            Text = "Available research candidates are listed below.\n" +
                   "All installations are disabled until signed artifacts, hardware eligibility, " +
                   "license checks and owner grants are implemented."
        };
        var rows = new ListView {
            Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true,
            MultiSelect = false, HideSelection = false, LabelEdit = false
        };
        rows.Columns.Add("Add-on", 238);
        rows.Columns.Add("Category", 180);
        rows.Columns.Add("Platform", 130);
        rows.Columns.Add("State", 155);
        var addons = OptionalAddonCatalog.Read();
        foreach (var addon in addons)
        {
            var row = new ListViewItem(addon.Name);
            row.SubItems.Add(addon.Category);
            row.SubItems.Add(addon.SupportsWindows ? "Windows candidate" : "Unsupported");
            row.SubItems.Add("Planned — disabled");
            rows.Items.Add(row);
        }
        if (addons.Count == 0)
        {
            rows.Items.Add(new ListViewItem(new[] {
                "Catalog unavailable", "Unverified", "Unknown", "Install disabled"
            }));
        }
        var footer = new Panel { Dock = DockStyle.Bottom, Height = 60 };
        var close = new Button {
            Text = "Close", Dock = DockStyle.Right, Width = 105,
            DialogResult = DialogResult.Cancel, Margin = new Padding(10)
        };
        footer.Padding = new Padding(12);
        footer.Controls.Add(close);
        CancelButton = close;
        Controls.Add(rows);
        Controls.Add(footer);
        Controls.Add(note);
    }
}
