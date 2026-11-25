using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;

public static class RcWindowsGuiTakeover {
    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;
    private const uint WM_TIMER = 0x0113;
    private const uint WM_QUIT = 0x0012;
    private const uint WM_APP_ACQUIRE = 0x8001;
    private const uint WM_APP_RELEASE = 0x8002;
    private const uint WM_APP_STOP = 0x8003;
    private const uint WM_APP_INPUT = 0x8004;
    private const uint LLKHF_INJECTED = 0x10;
    private const uint LLKHF_LOWER_IL_INJECTED = 0x02;
    private const uint LLMHF_INJECTED = 0x01;
    private const uint LLMHF_LOWER_IL_INJECTED = 0x02;
    private const int WTS_CONNECTSTATE = 8;
    private const uint DESKTOP_READOBJECTS = 0x0001;

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT { public int x, y; public uint mouseData, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x, y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO { public uint cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
    private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);
    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO { public uint cbSize, dwTime; }
    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SetWindowsHookEx(int id, HookProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll", SetLastError=true)] private static extern int GetMessage(out MSG message, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG message);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError=true)] private static extern UIntPtr SetTimer(IntPtr hwnd, UIntPtr id, uint milliseconds, IntPtr callback);
    [DllImport("user32.dll")] private static extern bool KillTimer(IntPtr hwnd, UIntPtr id);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool BlockInput(bool block);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder name, int size, out int needed);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("wtsapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool WTSQuerySessionInformation(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr buffer);

    private static readonly object gate = new object();
    private static readonly object eventGate = new object();
    private static readonly System.Collections.Generic.Queue<string> events = new System.Collections.Generic.Queue<string>();
    private static readonly AutoResetEvent commandDone = new AutoResetEvent(false);
    private static Thread worker;
    private static uint workerId;
    private static HookProc keyboardCallback, mouseCallback;
    private static IntPtr keyboardHook = IntPtr.Zero, mouseHook = IntPtr.Zero;
    private static long lastPhysicalTicks, monitorStartedTicks, leaseExpiresAtMs;
    private static int parentProcessId;
    private static bool ready, protectionActive, protectionUncertain;
    private static string leaseId = null;
    private static long leaseDeadlineTicks;
    private static string commandResult;
    private static uint pendingTtlMs;
    private static IDictionary pendingInputRequest;
    private static string pendingStopFile;
    private static object inputResult;

    private static long NowTicks() { return Stopwatch.GetTimestamp(); }
    private static long TicksToMs(long ticks) { return (long)(ticks * 1000.0 / Stopwatch.Frequency); }
    private static void RecordPhysicalInput() { Interlocked.Exchange(ref lastPhysicalTicks, NowTicks()); }

    private static IntPtr KeyboardHook(int code, IntPtr wParam, IntPtr lParam) {
        if (code >= 0 && lParam != IntPtr.Zero) {
            KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            if ((data.flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED)) == 0) RecordPhysicalInput();
        }
        return CallNextHookEx(keyboardHook, code, wParam, lParam);
    }
    private static IntPtr MouseHook(int code, IntPtr wParam, IntPtr lParam) {
        if (code >= 0 && lParam != IntPtr.Zero) {
            MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            if ((data.flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED)) == 0) RecordPhysicalInput();
        }
        return CallNextHookEx(mouseHook, code, wParam, lParam);
    }

    private static string InputDesktopName() {
        IntPtr desktop = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
        if (desktop == IntPtr.Zero) return "";
        try {
            StringBuilder name = new StringBuilder(128);
            int needed;
            return GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed) ? name.ToString() : "";
        } finally { CloseDesktop(desktop); }
    }
    private static bool SessionActive() {
        int session = Process.GetCurrentProcess().SessionId;
        if (session <= 0) return false;
        IntPtr buffer = IntPtr.Zero;
        int bytes = 0;
        if (!WTSQuerySessionInformation(IntPtr.Zero, session, WTS_CONNECTSTATE, out buffer, out bytes)) return false;
        try { return bytes >= 4 && Marshal.ReadInt32(buffer) == 0; }
        finally { WTSFreeMemory(buffer); }
    }
    public static bool IsInteractiveDefaultDesktop() {
        if (!Environment.UserInteractive || Process.GetCurrentProcess().SessionId <= 0 || !SessionActive()) return false;
        return String.Equals(InputDesktopName(), "Default", StringComparison.OrdinalIgnoreCase);
    }
    private static string OwnerSid() {
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
            return identity.User == null ? "" : identity.User.Value;
        }
    }
    public static object DescribeSession() {
        int session = Process.GetCurrentProcess().SessionId;
        bool interactive = IsInteractiveDefaultDesktop();
        string sid = OwnerSid();
        var capabilities = new {
            observe = interactive && IsMonitorReady, screenshot = interactive, activityDetection = interactive && IsMonitorReady,
            physicalInputProtection = interactive && IsMonitorReady, emergencyRelease = interactive && IsMonitorReady,
            pointer = interactive && IsMonitorReady, keyboard = interactive && IsMonitorReady, semanticInvoke = interactive,
            isolatedDesktop = false
        };
        return new {
            providerId = "windows-blockinput-" + session.ToString() + "-" + sid,
            platform = "win32", transport = "windows-lowlevel-hooks+BlockInput",
            activityEvidenceSource = "physical", activityEvidenceIncludesSynthetic = false,
            isolationAuthority = (string)null,
            session = new {
                ownerPrincipal = sid, sessionId = session.ToString(),
                seatId = "windows-session-" + session.ToString(),
                displayId = "windows-session-" + session.ToString() + "-Default",
                interactive = interactive, ownerAuthenticated = !String.IsNullOrEmpty(sid)
            },
            capabilities = capabilities
        };
    }
    public static object GetPhysicalActivityEvidence() {
        long last = Interlocked.Read(ref lastPhysicalTicks);
        long idle = TicksToMs(NowTicks() - last);
        return new {
            source = "physical", reliable = ready && IsInteractiveDefaultDesktop(),
            excludesSyntheticInput = true, observedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            idleMs = Math.Max(0, idle), monitorStartedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - TicksToMs(Interlocked.Read(ref monitorStartedTicks))
        };
    }
    private static void SetCommandResult(string result) {
        lock (gate) { commandResult = result; }
        commandDone.Set();
    }
    private static bool Post(uint message) {
        return workerId != 0 && PostThreadMessage(workerId, message, UIntPtr.Zero, IntPtr.Zero);
    }
    private static void ReleaseOnWorker(string reason) {
        if (!protectionActive) return;
        bool defaultDesktop = IsInteractiveDefaultDesktop();
        bool ok = BlockInput(false); // same thread that acquired the block
        // Windows itself releases BlockInput on the secure-attention sequence;
        // a non-Default input desktop is the independent OS-owned release signal.
        if (!ok && !defaultDesktop) ok = true;
        protectionActive = false;
        leaseDeadlineTicks = 0;
        leaseExpiresAtMs = 0;
        if (ok) {
            leaseId = null;
            lock (eventGate) events.Enqueue(reason);
        } else {
            protectionUncertain = true;
            lock (eventGate) events.Enqueue("INPUT_RELEASE_UNCONFIRMED");
        }
    }
    private static int Number(IDictionary source, string key, int fallback) {
        if (source == null || !source.Contains(key) || source[key] == null) return fallback;
        return Convert.ToInt32(source[key]);
    }
    private static string Text(IDictionary source, string key, string fallback) {
        if (source == null || !source.Contains(key) || source[key] == null) return fallback;
        return Convert.ToString(source[key]);
    }
    private static IDictionary Map(IDictionary source, string key) {
        return source != null && source.Contains(key) ? source[key] as IDictionary : null;
    }
    private static int[] Point(IDictionary value, IDictionary expected) {
        if (value == null) throw new InvalidOperationException("GUI_EXPECTED_FRAME_INVALID");
        int index = Number(value, "screenIndex", Number(expected, "screenIndex", -1));
        int observedIndex = Number(expected, "screenIndex", -2);
        if (index != observedIndex) throw new InvalidOperationException("GUI_MONITOR_NOT_OBSERVED");
        List<RECT> monitors = MonitorBounds();
        if (index < 0 || index >= monitors.Count) throw new InvalidOperationException("GUI_MONITOR_RANGE");
        RECT bounds = monitors[index];
        int width=bounds.right-bounds.left, height=bounds.bottom-bounds.top;
        IDictionary observedBounds = Map(expected, "bounds");
        if (observedBounds == null ||
            Number(observedBounds, "left", Int32.MinValue) != bounds.left ||
            Number(observedBounds, "top", Int32.MinValue) != bounds.top ||
            Number(observedBounds, "width", Int32.MinValue) != width ||
            Number(observedBounds, "height", Int32.MinValue) != height)
            throw new InvalidOperationException("GUI_MONITOR_GEOMETRY_CHANGED");
        int px, py;
        if (String.Equals(Text(value, "coordinateMode", "absolute"), "relative", StringComparison.OrdinalIgnoreCase)) {
            double x = Convert.ToDouble(value["x"]), y = Convert.ToDouble(value["y"]);
            if (x < 0 || x > 1 || y < 0 || y > 1) throw new InvalidOperationException("GUI_RELATIVE_RANGE");
            px = bounds.left + (int)Math.Round(x * (width - 1));
            py = bounds.top + (int)Math.Round(y * (height - 1));
        } else {
            px = Number(value, "x", Int32.MinValue);
            py = Number(value, "y", Int32.MinValue);
        }
        if (px < bounds.left || px >= bounds.right || py < bounds.top || py >= bounds.bottom)
            throw new InvalidOperationException("GUI_POINT_OUTSIDE_MONITOR");
        return new int[] {px, py};
    }
    private static List<RECT> MonitorBounds() {
        List<RECT> result = new List<RECT>();
        MonitorEnumProc callback = delegate(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data) {
            MONITORINFO info = new MONITORINFO();
            info.cbSize = (uint)Marshal.SizeOf(typeof(MONITORINFO));
            if (GetMonitorInfo(monitor, ref info)) result.Add(info.rcMonitor);
            return true;
        };
        if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero) || result.Count == 0)
            throw new InvalidOperationException("GUI_MONITOR_ENUM_FAILED");
        return result;
    }
    private static bool PhysicalInputHeld() {
        foreach (int key in new int[] {1,2,4,0x10,0x11,0x12,0x5B,0x5C})
            if ((GetAsyncKeyState(key) & 0x8000) != 0) return true;
        return false;
    }
    private static object ExecuteNativeInput(IDictionary request, string stopFile) {
        if (request == null || !IsProtectionActive) throw new InvalidOperationException("GUI_TAKEOVER_NOT_ACTIVE");
        if (!IsInteractiveDefaultDesktop()) throw new InvalidOperationException("GUI_DESKTOP_UNAVAILABLE");
        IDictionary expected = Map(request, "expected");
        if (expected == null) throw new InvalidOperationException("GUI_EXPECTED_FRAME_REQUIRED");
        string foreground = Text(expected, "foreground", "");
        uint foregroundPid = unchecked((uint)Number(expected, "processId", 0));
        if (String.IsNullOrEmpty(foreground) || foregroundPid == 0)
            throw new InvalidOperationException("GUI_EXPECTED_FRAME_INVALID");
        RcGuiNative.CheckForeground(foreground, foregroundPid);
        string action = Text(request, "action", "");
        switch (action) {
            case "move": {
                int[] p = Point(request, expected);
                RcGuiNative.Move(p[0], p[1], stopFile);
                break;
            }
            case "moveRelative":
                RcGuiNative.Delta(Number(request,"dx",0), Number(request,"dy",0), stopFile);
                break;
            case "scroll":
                RcGuiNative.Scroll(Number(request,"delta",0), Convert.ToBoolean(request["horizontal"]), stopFile);
                break;
            case "click": {
                int[] p = Point(request, expected);
                RcGuiNative.Move(p[0], p[1], stopFile);
                RcGuiNative.Click(Text(request,"button","left"), Number(request,"clicks",1), Number(request,"intervalMs",120), stopFile);
                break;
            }
            case "drag": {
                int[] a = Point(Map(request,"from"), expected);
                int[] b = Point(Map(request,"to"), expected);
                RcGuiNative.Drag(a[0],a[1],b[0],b[1],Number(request,"durationMs",500),
                    Number(request,"steps",24),Text(request,"button","left"),stopFile);
                break;
            }
            case "keyPress": {
                Array values = request["keys"] as Array;
                if (values == null || values.Length < 1 || values.Length > 6)
                    throw new InvalidOperationException("GUI_INPUT_BOUNDS");
                string[] keys = new string[values.Length];
                for (int i=0;i<values.Length;i++) keys[i]=Convert.ToString(values.GetValue(i));
                RcGuiNative.KeyCombo(keys, Number(request,"holdMs",0), stopFile);
                break;
            }
            case "typeText":
                RcGuiNative.TypeUnicode(Text(request,"text",""), Number(request,"intervalMs",0),
                    stopFile, foreground, foregroundPid);
                break;
            case "focusWindow":
                RcGuiNative.Focus(Text(request,"handle",""), stopFile);
                break;
            default:
                throw new InvalidOperationException("GUI_UNKNOWN_ACTION");
        }
        return new {
            ok=true, action=action,
            foreground=RcGuiNative.Foreground(),
            processId=RcGuiNative.ForegroundPid(),
            nativeThreadId=GetCurrentThreadId()
        };
    }

    public static object InvokeInput(IDictionary request, string stopFile) {
        lock (gate) {
            if (!protectionActive) return new { ok=false, error="GUI_TAKEOVER_NOT_ACTIVE" };
            if (pendingInputRequest != null) return new { ok=false, error="GUI_NATIVE_BUSY" };
            pendingInputRequest = request;
            pendingStopFile = stopFile;
            inputResult = null;
            commandResult = null;
            commandDone.Reset();
            if (!Post(WM_APP_INPUT)) {
                pendingInputRequest = null;
                return new { ok=false, error="GUI_NATIVE_DISPATCH_FAILED" };
            }
        }
        if (!commandDone.WaitOne(15000)) return new { ok=false, error="GUI_NATIVE_INPUT_TIMEOUT" };
        lock (gate) return inputResult ?? (object)new { ok=false, error="GUI_NATIVE_INPUT_RESULT_MISSING" };
    }

    private static void WorkerMain() {
        workerId = GetCurrentThreadIdCompat();
        PeekMessageForQueue();
        keyboardCallback = new HookProc(KeyboardHook);
        mouseCallback = new HookProc(MouseHook);
        IntPtr module = GetModuleHandle(null);
        keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardCallback, module, 0);
        mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseCallback, module, 0);
        if (keyboardHook == IntPtr.Zero || mouseHook == IntPtr.Zero) {
            if (keyboardHook != IntPtr.Zero) UnhookWindowsHookEx(keyboardHook);
            if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
            keyboardHook = IntPtr.Zero; mouseHook = IntPtr.Zero;
            lock (gate) { ready = false; }
            SetCommandResult("HOOK_INSTALL_FAILED");
            return;
        }
        Interlocked.Exchange(ref lastPhysicalTicks, NowTicks());
        lock (gate) { ready = true; }
        Interlocked.Exchange(ref monitorStartedTicks, NowTicks());
        SetCommandResult("READY");
        UIntPtr timer = SetTimer(IntPtr.Zero, new UIntPtr(1), 100, IntPtr.Zero);
        MSG msg;
        try {
            while (true) {
                int result = GetMessage(out msg, IntPtr.Zero, 0, 0);
                if (result <= 0 || msg.message == WM_QUIT) break;
                if (msg.message == WM_APP_ACQUIRE) {
                    lock (gate) {
                        if (protectionActive) { commandResult = "ALREADY_ACTIVE"; commandDone.Set(); continue; }
                    }
                    if (!IsInteractiveDefaultDesktop()) { SetCommandResult("DESKTOP_UNAVAILABLE"); continue; }
                    if (PhysicalInputHeld()) { SetCommandResult("PHYSICAL_INPUT_HELD"); continue; }
                    if (!BlockInput(true)) { SetCommandResult("BLOCK_INPUT_FAILED"); continue; }
                    lock (gate) {
                        protectionActive = true;
                        protectionUncertain = false;
                        leaseId = Guid.NewGuid().ToString("N");
                        leaseDeadlineTicks = NowTicks() + (long)(pendingTtlMs / 1000.0 * Stopwatch.Frequency);
                        leaseExpiresAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + pendingTtlMs;
                        commandResult = "ACQUIRED";
                    }
                    commandDone.Set();
                } else if (msg.message == WM_APP_INPUT) {
                    IDictionary request;
                    string stop;
                    lock (gate) { request=pendingInputRequest; stop=pendingStopFile; }
                    object inputOutcome;
                    try { inputOutcome=ExecuteNativeInput(request,stop); }
                    catch (Exception error) {
                        string code=System.Text.RegularExpressions.Regex.Match(error.Message,"GUI_[A-Z0-9_]+").Value;
                        inputOutcome=new {ok=false,error=String.IsNullOrEmpty(code)?"GUI_NATIVE_INPUT_FAILED":code};
                    }
                    lock (gate) { inputResult=inputOutcome;pendingInputRequest=null;pendingStopFile=null;commandResult="INPUT_DONE"; }
                    commandDone.Set();
                } else if (msg.message == WM_APP_RELEASE) {
                    ReleaseOnWorker("OWNER_RELEASE");
                    SetCommandResult(protectionUncertain ? "RELEASE_UNCONFIRMED" : "RELEASED");
                } else if (msg.message == WM_APP_STOP) {
                    ReleaseOnWorker("AGENT_STOP");
                    break;
                } else if (msg.message == WM_TIMER) {
                    bool active;
                    long deadline;
                    lock (gate) { active = protectionActive; deadline = leaseDeadlineTicks; }
                    if (!ParentAlive()) {
                        ReleaseOnWorker("AGENT_DISCONNECTED");
                        Post(WM_QUIT);
                    } else if (active) {
                        if (!IsInteractiveDefaultDesktop()) ReleaseOnWorker("OS_SECURE_ATTENTION");
                        else if (NowTicks() >= deadline) ReleaseOnWorker("LEASE_EXPIRED");
                    }
                } else {
                    TranslateMessage(ref msg);
                    DispatchMessage(ref msg);
                }
            }
        } finally {
            ReleaseOnWorker("AGENT_STOP");
            if (timer != UIntPtr.Zero) KillTimer(IntPtr.Zero, timer);
            if (keyboardHook != IntPtr.Zero) UnhookWindowsHookEx(keyboardHook);
            if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
            keyboardHook = IntPtr.Zero; mouseHook = IntPtr.Zero;
            lock (gate) { ready = false; workerId = 0; }
        }
    }
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
    private static uint GetCurrentThreadIdCompat() { return GetCurrentThreadId(); }
    private static void PeekMessageForQueue() { MSG msg; PeekMessage(out msg, IntPtr.Zero, 0, 0, 0); }

    public static void SetParentProcess(int pid) {
        if (pid <= 0) throw new ArgumentOutOfRangeException("pid");
        parentProcessId = pid;
    }
    private static bool ParentAlive() {
        int pid = parentProcessId;
        if (pid <= 0) return true;
        try { using (Process parent = Process.GetProcessById(pid)) return !parent.HasExited; }
        catch { return false; }
    }
    public static bool StartMonitor() {
        lock (gate) {
            if (worker != null && worker.IsAlive) return ready;
            if (!IsInteractiveDefaultDesktop()) return false;
            commandResult = null;
            commandDone.Reset();
            worker = new Thread(WorkerMain);
            worker.IsBackground = true;
            worker.Name = "Commander-Windows-GUI-InputProtection";
            worker.Start();
        }
        if (!commandDone.WaitOne(5000)) return false;
        lock (gate) return ready && commandResult == "READY";
    }
    private static string SendCommand(uint command, uint ttlMs) {
        lock (gate) {
            commandResult = null;
            pendingTtlMs = ttlMs;
            commandDone.Reset();
            if (!Post(command)) return "POST_FAILED";
        }
        if (!commandDone.WaitOne(2500)) return "COMMAND_TIMEOUT";
        lock (gate) return commandResult ?? "COMMAND_RESULT_MISSING";
    }
    public static object AcquireProtection(uint ttlMs) {
        if (ttlMs < 10000 || ttlMs > 120000) return new { ok = false, error = "INVALID_LEASE_TTL" };
        if (!StartMonitor()) return new { ok = false, error = "NATIVE_MONITOR_UNAVAILABLE" };
        string result = SendCommand(WM_APP_ACQUIRE, ttlMs);
        if (result != "ACQUIRED") return new { ok = false, error = result };
        string currentLease;
        lock (gate) currentLease = leaseId;
        long expiry;
        lock (gate) expiry = leaseExpiresAtMs;
        return new { ok = true, receipt = new {
            active = true, kind = "NATIVE_PHYSICAL_INPUT_PROTECTION",
            providerId = DescribeProviderId(), sessionId = Process.GetCurrentProcess().SessionId.ToString(),
            leaseId = currentLease, releaseOnAgentExit = true, releaseOnEmergency = true, expiresAtMs = expiry
        }};
    }
    private static string DescribeProviderId() {
        return "windows-blockinput-" + Process.GetCurrentProcess().SessionId.ToString() + "-" + OwnerSid();
    }
    public static object ReleaseProtectionForLease(string expectedLeaseId) {
        lock (gate) {
            if (protectionActive && !String.Equals(leaseId, expectedLeaseId, StringComparison.Ordinal))
                return new { ok = false, error = "GUI_NATIVE_LEASE_MISMATCH", released = false };
        }
        return ReleaseProtection();
    }
    public static object ReleaseProtection() {
        string result = SendCommand(WM_APP_RELEASE, 0);
        return new { ok = result == "RELEASED", error = result, released = result == "RELEASED" };
    }
    public static string[] DrainEvents() {
        lock (eventGate) {
            string[] result = events.ToArray();
            events.Clear();
            return result;
        }
    }
    public static bool IsMonitorReady { get { lock (gate) return ready; } }
    public static bool IsProtectionActive { get { lock (gate) return protectionActive; } }
    public static bool IsProtectionUncertain { get { lock (gate) return protectionUncertain; } }
}
