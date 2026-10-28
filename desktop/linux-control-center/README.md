# Remote Commander Control Center — R32 GTK4/Adwaita

This is a **read-only native** Control Center candidate for Linux. It does not replace a running Commander release, install a service, elevate privileges, access browser profiles, or execute workflows.

The original owner-private telemetry readers remain in `control_center.py`: bounded JSON, exact owner and file-mode guards, canonical routing runtime pairs, and SQLite `mode=ro` + `PRAGMA query_only=ON`. `dashboard_ui.py` is presentation-only and receives sanitized callbacks.

## Visual system
- Adaptive dark/light GNOME color scheme, consistent overview/metric cards, sidebar navigation and readable typography.
- Connection, native GUI, background Browser and live-operation state **do not** fabricate green/healthy from missing data.
- Profiles are canonical read-only records; workflows show persisted state, not a claim that an active worker is running.
- Search filters workflow rows without network, shell, execution or credential access.
- Refresh does not rebuild unchanged workflow/profile lists, preserving search state and scroll.
- Security and control authority are shown explicitly; task mutations require a future separately accepted authenticated Core IPC.

## Verification
Run `python3 -B -m unittest discover -s desktop/linux-control-center -p 'test*.py' -v`. R32 Emad Linux isolated run: **16 passed**, log SHA256 `c075df222601cff3f05c36f114a4f29936b2995e8832a31ffba3f51b7b50491d`.

A synthetic GTK4 Broadway visual experiment **failed** (SIGSEGV in libgtk-4.so.1); this is an OPEN independent Native GUI validation gate. Backtrace SHA256 `eb2c970fdef8318f863082c629f72ffc74e0d12c133a7b6826403f70e40facd3`. Do not classify native rendering as PASS. All synthetic Broadway processes were terminated and the live desktop remained untouched.

Never use this preview to assume real runner state, submit changes to user workflows or close STOP/Mutex gates. Production installation is not performed by this PR.

## Portable QA package (source-only; no public Linux installation)

To build a reproducible, exact-source non-installing QA bundle on Linux:

```bash
python3 tools/build-linux-control-center-preview.py --output /tmp/Remote-Commander-Linux-Control-Center-QA.zip
```

Unzip in a disposable directory and use `sh run-control-center.sh --audit` to check read-only state without a GUI. Manual native GTK4/libadwaita testing is explicit: `sh run-control-center.sh`. The bundled `MANIFEST.json` binds the source commit and component hashes; `SHA256SUMS.txt` independently covers the packaged files. Building or extracting this ZIP never installs files into the owner's profile, OS, service manager or existing Commander environment.

The archive is deliberately **not** part of the public Linux Core single-file installer, does not set the Linux product selector to available and grants no GUI input/control permissions. Native GUI acceptance, user-local installer/rollback, and independent reviewer approval remain distinct release gates. The historical Broadway crash above is retained as evidence of that earlier R32 experiment, not overwritten by later hosted R35 synthetic success.

### Optional per-user QA lifecycle (explicit only)

From an extracted ZIP, run `python3 manage-userlocal.py --status --ack-qa-only` to inspect the isolated QA slot.

- `python3 manage-userlocal.py --install --ack-qa-only`: install a verified archive under `~/.local/share/RemoteCommander-ControlCenter-QA-Only/current`; a pre-existing verified QA version can move to `previous`. No `sudo`, service, login, autostart, installed Commander profile, or OS-global change
- `python3 manage-userlocal.py --rollback --ack-qa-only`: atomically swap the two verified QA slots; never change Core or any other product
- `python3 manage-userlocal.py --recover --ack-qa-only`: only repair recognized and byte-verified interrupted QA staging or rollback renames, rejecting ambiguous or unknown files
- `python3 manage-userlocal.py --uninstall --ack-qa-only`: delete only byte-verified, owner-private QA slot files; unknown files or tampering prevent deletion

One rollback slot is retained; a second upgrade is refused until the previous QA slot is handled. No automatic promotion or updates. QA-only SHA256 manifests detect tampering, **not publisher authenticity**. This is not a signed or independently accepted public Linux installer. Other user-owned files and the production application must never be modified.
