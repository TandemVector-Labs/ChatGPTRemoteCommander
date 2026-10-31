using System.Drawing;
using System.Windows.Forms;

namespace RemoteCommander;

internal sealed record ProfileRow(
    string Name, int Generation, string Version, string Commit,
    int BackendPort, int RouterPort, int RouterPid,
    DateTimeOffset? UpdatedAt, string ProjectDir,
    string BackendConfigSha256, string RouterSourceSha256,
    bool IsolatedInstance = false);

internal static class Program
{
    [STAThread]
    private static int Main()
    {
        ApplicationConfiguration.Initialize();
        var chrome = new DashboardChrome();
        if (chrome.Metrics is not TableLayoutPanel table || table.ColumnCount != 4)
            throw new Exception("R34_METRIC_GRID_CARDINALITY");
        if (table.Controls.Count != 4)
            throw new Exception("R34_MISSING_METRICS");

        var cards = new FlowLayoutPanel { Width = 900, Height = 500 };
        var primary = new Panel { Tag = "primary", Width = 700, Height = 100 };
        var secondary = new Panel { Tag = "secondary", Width = 700, Height = 100 };
        cards.Controls.Add(primary);
        cards.Controls.Add(secondary);
        chrome.Attach(cards);
        chrome.ApplyTheme(false);
        var backgroundLight = table.BackColor;
        chrome.ApplyTheme(true);
        var backgroundDark = table.BackColor;
        if (backgroundLight == backgroundDark)
            throw new Exception("R34_DARK_LIGHT_THEME_NOT_APPLIED");

        var profiles = new ProfileRow[] {
            new("default", 34, "0.10.20", "362375c", 48831, 48831, 42, null, "C:/private",
                new string('a', 64), new string('b', 64))
        };
        chrome.Update(profiles);
        var actual = table.Controls.OfType<Panel>()
            .SelectMany(p => p.Controls.OfType<Label>())
            .Select(l => l.Text).ToArray();
        if (!actual.Contains("1") || !actual.Contains("0.10.20")
            || !actual.Contains("UNVERIFIED") || !actual.Contains("READ ONLY"))
            throw new Exception("R34_FALSE_METRIC_VALUES");

        // Screen readers must identify each metric, not announce an ambiguous "Evidence: 1".
        foreach (var tile in table.Controls.OfType<Panel>())
        {
            var labels = tile.Controls.OfType<Label>().ToArray();
            var title = labels.Single(l => l.Text is "Discovered profiles" or "Core versions"
                or "Live operations" or "Control authority");
            var valueLabel = labels.Single(l => l.Font.Size > 16);
            if (!(valueLabel.AccessibleName ?? "").Contains(title.Text,
                    StringComparison.OrdinalIgnoreCase) ||
                string.IsNullOrWhiteSpace(valueLabel.AccessibleDescription))
                throw new Exception("R34_METRIC_CONTEXT_MISSING_FROM_ACCESSIBLE_NAME");
        }
        Console.WriteLine("R34_NATIVE_METRIC_SCREEN_READER_CONTEXT_PASS");

        // Isolated records increase the profile count without inventing a Core version.
        chrome.Update(profiles.Concat(new[] {
            new ProfileRow("MMZ", 0, "unknown", "", 47836, 0, 0, null, "",
                new string('c', 64), "", true)
        }));
        var isolatedMetricValues = table.Controls.OfType<Panel>()
            .SelectMany(p => p.Controls.OfType<Label>())
            .Select(l => l.Text).ToArray();
        if (!isolatedMetricValues.Contains("2") ||
            !isolatedMetricValues.Contains("0.10.20") ||
            isolatedMetricValues.Contains("MIXED") ||
            isolatedMetricValues.Contains("unknown"))
            throw new Exception("R34_ISOLATED_METRIC_OR_VERSION_INVENTED");

        if (chrome.Search is not Panel search || search.Controls.OfType<TextBox>().Count() != 1)
            throw new Exception("R34_MISSING_ACCESSIBLE_SEARCH");
        var field = search.Controls.OfType<TextBox>().Single();
        if (field.AccessibleName != "Filter verified local routing profiles")
            throw new Exception("R34_SEARCH_A11Y");
        field.Text = "primary";
        chrome.ApplyFilter();
        if (!primary.Visible && secondary.Visible)
            throw new Exception("R34_FILTER_IGNORED");

        DashboardChrome.RoundCard(primary, 16);
        primary.Size = new Size(700, 110);
        if (primary.Region is null)
            throw new Exception("R34_ROUNDED_CARD_REGION");
        // Pure read-only router/backend/profiles matching: never generate a user GUI action.
        const string commit = "362375c464948be3001b307650c13fc3353ed05b";
        var expected = new ProfileRow("default", 34, "0.10.20", commit,
            48831, 47831, 42, null, "C:/private", new string('a', 64), new string('b', 64));
        var route = System.Text.Json.JsonSerializer.Serialize(new {
            ok=true, router=true, listenPort=47831, sourceSha256=new string('b',64),
            state=new { profile="default", generation=34,
                active=new {version="0.10.20", commit, port=48831, configSha256=new string('a',64)} }
        });
        var backend = System.Text.Json.JsonSerializer.Serialize(new {
            ok=true, name="chatgpt-remote-commander", version="0.10.20",
            configSha256=new string('a',64), instance=new { profile="default" }
        });
        if (!ProfileHealthEvidence.Matches(expected, route, backend))
            throw new Exception("R590_VALID_PROFILE_IDENTITY_NOT_ACCEPTED");
        foreach (var bad in new[] {
            route.Replace("\"default\"","\"wrong\""),
            route.Replace("47831","40000"),
            route.Replace(new string('b',64),new string('f',64)),
            route.Replace(commit, new string('0',40))
        }) if (ProfileHealthEvidence.Matches(expected, bad, backend))
            throw new Exception("R590_FALSE_ROUTER_IDENTITY_ACCEPTED");
        foreach (var bad in new[] {
            backend.Replace("\"default\"","\"wrong\""),
            backend.Replace(new string('a',64),new string('f',64)),
            backend.Replace("0.10.20","0.10.22")
        }) if (ProfileHealthEvidence.Matches(expected, route, bad))
            throw new Exception("R590_FALSE_BACKEND_IDENTITY_ACCEPTED");
        if (ProfileHealthEvidence.Matches(expected, "{", backend))
            throw new Exception("R590_BAD_JSON_ACCEPTED");
        Console.WriteLine("R590_ROUTER_BACKEND_PROFILE_IDENTITY_OFFSCREEN_PASS");

        chrome.Footer.Dispose();
        chrome.Search.Dispose();
        chrome.Metrics.Dispose();
        cards.Dispose();
        Console.WriteLine("R34_NATIVE_WINFORMS_STRUCTURE_THEME_A11Y_NO_SCREEN_PASS");
        return 0;
    }
}
