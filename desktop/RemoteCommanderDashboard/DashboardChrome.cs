using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace RemoteCommander;

// Presentation-only module. No shell, HTTP, registry mutations or Core commands.
internal sealed class DashboardChrome
{
    private FlowLayoutPanel? cards;
    private readonly TableLayoutPanel metrics = new()
    {
        Dock = DockStyle.Top, Height = 122, ColumnCount = 4, RowCount = 1,
        Padding = new Padding(18, 8, 18, 8)
    };
    private readonly Panel searchBar = new() { Dock = DockStyle.Top, Height = 54, Padding = new Padding(24, 6, 24, 8) };
    private readonly TextBox filter = new()
    {
        Dock = DockStyle.Fill, PlaceholderText = "Find a verified profile…",
        Font = new Font("Segoe UI", 10.5f),
        AccessibleName = "Filter verified local routing profiles",
        BorderStyle = BorderStyle.FixedSingle
    };
    private readonly Label footer = new()
    {
        Dock = DockStyle.Bottom, Height = 27, TextAlign = ContentAlignment.MiddleCenter,
        Text = "Owner-private monitoring  •  No automatic workflow execution  •  Identity and release gates remain independent",
        Font = new Font("Segoe UI", 8.5f)
    };
    private readonly List<Panel> shells = new();
    private readonly List<Label> values = new();
    private readonly List<string> metricTitles = new();
    private readonly List<Label> captions = new();

    public Control Metrics => metrics;
    public Control Search => searchBar;
    public Control Footer => footer;

    public DashboardChrome()
    {
        for (var i = 0; i < 4; i++)
            metrics.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25f));
        var items = new[]
        {
            ("Discovered profiles", "UNVERIFIED", "Routed + isolated records"),
            ("Core versions", "UNVERIFIED", "Reported metadata, not release"),
            ("Live operations", "UNVERIFIED", "No authenticated worker receipt"),
            ("Control authority", "READ ONLY", "Mutation never inferred")
        };
        for (var i = 0; i < items.Length; i++)
            metrics.Controls.Add(Tile(items[i].Item1, items[i].Item2, items[i].Item3), i, 0);
        searchBar.Controls.Add(filter);
        filter.TextChanged += (_, _) => ApplyFilter();
    }
    private Panel Tile(string title, string initial, string caption)
    {
        var card = new Panel { Dock = DockStyle.Fill, Margin = new Padding(5), Padding = new Padding(17) };
        RoundCard(card, 16);
        var header = new Label
        {
            Dock = DockStyle.Top, Height = 23, Text = title,
            Font = new Font("Segoe UI Semibold", 9.1f)
        };
        var value = new Label
        {
            Dock = DockStyle.Top, Height = 40, Text = initial,
            Font = new Font("Segoe UI Semibold", 18.5f, FontStyle.Bold),
            AccessibleName = title + ": " + initial, AutoEllipsis = true
        };
        var detail = new Label
        {
            Dock = DockStyle.Bottom, Height = 23, Text = caption,
            Font = new Font("Segoe UI", 8.2f), AutoEllipsis = true
        };
        card.Controls.Add(detail);
        card.Controls.Add(value);
        card.Controls.Add(header);
        shells.Add(card); values.Add(value); captions.Add(detail);
        metricTitles.Add(title);
        return card;
    }
    public void Attach(FlowLayoutPanel cardsPanel)
    {
        cards = cardsPanel;
        cards.SizeChanged += (_, _) =>
        {
            foreach (var card in cards.Controls.OfType<Panel>())
                card.Width = Math.Max(600, cards.ClientSize.Width - 42);
        };
    }
    public void ApplyTheme(bool dark)
    {
        var background = dark ? Color.FromArgb(16, 24, 39) : Color.FromArgb(246, 248, 252);
        var tile = dark ? Color.FromArgb(28, 40, 58) : Color.White;
        var primary = dark ? Color.FromArgb(239, 245, 253) : Color.FromArgb(20, 32, 49);
        var accent = dark ? Color.FromArgb(147, 197, 253) : Color.FromArgb(29, 78, 216);
        var muted = dark ? Color.FromArgb(183, 200, 220) : Color.FromArgb(91, 106, 125);
        metrics.BackColor = background;
        searchBar.BackColor = background;
        filter.BackColor = tile; filter.ForeColor = primary;
        footer.BackColor = background; footer.ForeColor = muted;
        for (int i = 0; i < shells.Count; i++)
        {
            shells[i].BackColor = tile;
            var labels = shells[i].Controls.OfType<Label>().ToList();
            foreach (var label in labels) label.ForeColor = label.Font.Size > 16 ? accent : primary;
            captions[i].ForeColor = muted;
        }
    }
    public void Update(IEnumerable<ProfileRow> profiles)
    {
        var rows = profiles.ToList();
        var versions = rows.Where(p => !p.IsolatedInstance).Select(p => p.Version)
                           .Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        Set(0, rows.Count.ToString(), true);
        Set(1, versions.Count switch { 0 => "UNVERIFIED", 1 => versions[0], _ => "MIXED" }, true);
        Set(2, "UNVERIFIED", false);
        Set(3, "READ ONLY", false);
        ApplyFilter();
    }
    private void Set(int index, string value, bool evidence)
    {
        values[index].Text = value;
        values[index].AccessibleName = metricTitles[index] + ": "
            + (evidence ? "Recorded " : "Not accepted ") + value;
        values[index].AccessibleDescription = captions[index].Text;
    }
    public void ApplyFilter()
    {
        if (cards is null) return;
        var query = filter.Text.Trim();
        foreach (var p in cards.Controls.OfType<Panel>())
            p.Visible = query.Length == 0 ||
                (p.Tag as string ?? "").Contains(query, StringComparison.OrdinalIgnoreCase);
    }
    public static void RoundCard(Panel panel, int radius)
    {
        panel.Resize += (_, _) =>
        {
            if (panel.Width < 2 || panel.Height < 2) return;
            var area = new Rectangle(0, 0, panel.Width, panel.Height);
            using var rounded = new GraphicsPath();
            var diameter = Math.Min(radius * 2, Math.Min(area.Width, area.Height));
            rounded.AddArc(area.Left, area.Top, diameter, diameter, 180, 90);
            rounded.AddArc(area.Right - diameter, area.Top, diameter, diameter, 270, 90);
            rounded.AddArc(area.Right - diameter, area.Bottom - diameter, diameter, diameter, 0, 90);
            rounded.AddArc(area.Left, area.Bottom - diameter, diameter, diameter, 90, 90);
            rounded.CloseFigure();
            var old = panel.Region;
            panel.Region = new Region(rounded);
            old?.Dispose();
        };
    }
}
