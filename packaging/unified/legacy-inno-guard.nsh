; RC012 transitional duplicate-install guard (NSIS / electron-builder v26).
; This pilot MUST NOT silently install a second Commander beside legacy Inno.
; The production cutover will replace this fail-closed guard only after signed
; artifacts, owner authorization, profile backup, rollback and health receipts.
!macro customInit
  ReadRegStr $R8 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RemoteCommander" "UninstallString"
  StrCmp $R8 "" +2
    Abort "RC012_LEGACY_INNO_PRESENT: This preview cannot replace your existing Remote Commander. No changes made."
  ReadRegStr $R8 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\RemoteCommander" "UninstallString"
  StrCmp $R8 "" +2
    Abort "RC012_LEGACY_INNO_PRESENT: This preview cannot replace the machine-level Remote Commander. No changes made."
  ReadRegStr $R8 HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\RemoteCommander" "UninstallString"
  StrCmp $R8 "" +2
    Abort "RC012_LEGACY_INNO_PRESENT: This preview cannot replace 32-bit legacy Remote Commander. No changes made."
!macroend
