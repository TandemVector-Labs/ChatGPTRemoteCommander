#!/usr/bin/env bash
# CI-only synthetic GTK4/Adwaita X11 smoke. No owner data, profiles or backend.
set -euo pipefail
[[ "${CI:-}" == true && -n "${GITHUB_WORKSPACE:-}" && -n "${RUNNER_TEMP:-}" ]] || { echo "CI_ONLY" >&2; exit 61; }
root="${GITHUB_WORKSPACE}/desktop/linux-control-center"
output="${GITHUB_WORKSPACE}/dist/ui-preview-r35"
[[ -f "$root/preview_fixture.py" && -f "$root/dashboard_ui.py" && ! -e "$output" ]] || { echo "SOURCE_OR_OUTPUT_CONFLICT" >&2; exit 62; }
mkdir -p "$output"
export RC_R35_PREVIEW_DIR="$output"
timeout --signal=TERM --kill-after=8s 90s dbus-run-session -- xvfb-run -a -s '-screen 0 1440x900x24' bash -euo pipefail -c '
  export GDK_BACKEND=x11 GSETTINGS_BACKEND=memory GTK_A11Y=none NO_AT_BRIDGE=1
  /usr/bin/python3 -B "$GITHUB_WORKSPACE/desktop/linux-control-center/preview_fixture.py" > "$RC_R35_PREVIEW_DIR/gtk.log" 2>&1 &
  pid=$!
  trap "kill $pid 2>/dev/null || true" EXIT
  # R217: A fixed 5s sleep was not enough on cold hosted CI: Python could be
  # alive but stalled on initial filesystem I/O before opening its X11 window.
  # Poll ONLY this isolated Xvfb fixture with a hard deadline, checking both the
  # actual native window and independently reported GTK layout observables.
  deadline=$((SECONDS + 45))
  winid=""
  phase="WINDOW_PENDING"
  while (( SECONDS < deadline )); do
    if ! kill -0 "$pid" 2>/dev/null; then phase="FIXTURE_EXITED"; break; fi
    winid="$(xdotool search --name "Remote Commander" | head -n 1 || true)"
    if [[ -n "$winid" ]] &&
       grep -q "^R36_NATIVE_STACK_PAGES=5_VISIBLE=5$" "$RC_R35_PREVIEW_DIR/gtk.log" &&
       grep -q "^R39_NAV_BUTTONS=5_DRAWN=5_ACTIVE=1$" "$RC_R35_PREVIEW_DIR/gtk.log" &&
       grep -Eq "^R46_SIDEBAR_CONTENT_WIDTH=[0-9]+$" "$RC_R35_PREVIEW_DIR/gtk.log"; then
      phase="WINDOW_AND_LAYOUT_READY"
      break
    fi
    sleep 0.5
  done
  if [[ "$phase" != "WINDOW_AND_LAYOUT_READY" ]]; then
    echo "R217_BOUNDED_GTK_READINESS_FAIL phase=$phase deadline=45s" >&2
    echo "R42_DIAGNOSTIC_GTK_PROCESS" >&2
    ps -o pid,ppid,stat,etime,wchan:24,cmd -p "$pid" >&2 || true
    echo "R42_DIAGNOSTIC_X11_TREE" >&2
    xwininfo -root -tree 2>&1 | head -n 24 >&2 || true
    echo "R42_DIAGNOSTIC_GTK_LOG" >&2
    cat "$RC_R35_PREVIEW_DIR/gtk.log" >&2 || true
    echo "GTK_NATIVE_WINDOW_OR_LAYOUT_NOT_READY" >&2
    exit 66
  fi
  echo "R217_BOUNDED_GTK_READINESS_PASS phase=$phase"
  grep -q "^R36_NATIVE_STACK_PAGES=5_VISIBLE=5$" "$RC_R35_PREVIEW_DIR/gtk.log" || { cat "$RC_R35_PREVIEW_DIR/gtk.log"; echo "STACK_FIVE_PAGES_NOT_ACCEPTED" >&2; exit 69; }
  grep -q "^R39_NAV_BUTTONS=5_DRAWN=5_ACTIVE=1$" "$RC_R35_PREVIEW_DIR/gtk.log" || { cat "$RC_R35_PREVIEW_DIR/gtk.log"; echo "SIDEBAR_FIVE_VISUAL_BUTTONS_NOT_ACCEPTED" >&2; exit 70; }
  # Always capture the visible window BEFORE any viewport-width acceptance:
  # an out-of-range width must preserve a real screenshot for diagnosis.
  xdotool getwindowgeometry --shell "$winid" > "$RC_R35_PREVIEW_DIR/window.txt"
  xwd -root -silent -out "$RC_R35_PREVIEW_DIR/preview.xwd"
  test -s "$RC_R35_PREVIEW_DIR/preview.xwd"
  echo "NATIVE_GTK_WINDOW_OPEN_SYNTHETIC_PASS"
'
convert "$output/preview.xwd" "$output/preview.png"
test "$(stat -c '%s' "$output/preview.png")" -gt 15000
colors="$(identify -format '%k' "$output/preview.png")"
[[ "$colors" =~ ^[0-9]+$ ]] || exit 67
((colors > 120)) || { echo "SCREENSHOT_EMPTY colors=$colors" >&2; exit 68; }
sha="$(sha256sum "$output/preview.png" | cut -d ' ' -f 1)"
sidebar_line="$(grep -E "^R46_SIDEBAR_CONTENT_WIDTH=[0-9]+$" "$output/gtk.log" | tail -n1 || true)"
sidebar_width="${sidebar_line#R46_SIDEBAR_CONTENT_WIDTH=}"
if [[ ! "$sidebar_width" =~ ^[0-9]+$ ]] || ((sidebar_width < 190 || sidebar_width > 260)); then
  printf '{"schema":1,"revision":"R46","status":"FAIL_NATIVE_SIDEBAR_WIDTH_AFTER_CAPTURE","width":"%s","captureSHA256":"%s","ownerProfileTouched":false}\n' "$sidebar_width" "$sha" >"$output/FAIL_R46.json"
  cat "$output/gtk.log"
  echo "SIDEBAR_WIDTH_OUT_OF_BOUNDS capture_saved width=$sidebar_width" >&2
  exit 72
fi
printf '{"schema":1,"revision":"R35","status":"PASS_SYNTHETIC_GTK4_ADWAITA_X11_RENDER_ONLY","captureSHA256":"%s","uniqueColors":%s,"userProfileTouched":false,"nativeOwnerAcceptance":false}\n' "$sha" "$colors" >"$output/PREVIEW_R35.json"
echo "R35_SYNTHETIC_X11_RENDER_PASS sha256=$sha colors=$colors"
